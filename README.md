# FM Family Quiz Buzzer

대한가정의학과의사회 가족 송년모임용 실시간 퀴즈 부저 시스템입니다.
참가자는 QR 코드로 접속해 닉네임만 입력하면 되고(앱 설치·회원가입 없음), 사회자가 부저를 열면 **서버(PostgreSQL)가 가장 먼저 접수한 1명**만 승자로 확정합니다.

| 경로 | 사용자 | 설명 |
| --- | --- | --- |
| `/join`, `/room/:roomCode` | 참가자 (모바일) | 닉네임 입장 → 부저 |
| `/admin` | 사회자 (데스크톱/태블릿) | 비밀번호 로그인 후 진행 |
| `/display`, `/display/:roomCode` | 대형 스크린 | 읽기 전용, 인증 불필요 |

---

## 1. 기술 설계 요약

**스택**: React 19 + Vite + TypeScript, Tailwind CSS v4, Supabase(PostgreSQL + Realtime), Vercel, Web Audio API, `qrcode`.

### 핵심 결정

1. **별도 API 서버 없음 — 모든 쓰기는 PostgreSQL RPC(`SECURITY DEFINER` 함수)로만.**
   브라우저는 공개용 anon 키만 갖고, 테이블에 직접 쓰기 권한이 전혀 없습니다. 함수 내부에서 토큰을 검증합니다. Edge Function/서버리스 함수가 필요 없어 구성 요소가 최소화됩니다.
2. **승자 판정 = 조건부 UPDATE 1문장** (`supabase/migrations/…_buzzer.sql`의 `public.buzz`)
   ```sql
   update rounds set status='LOCKED', winner_id=…, winner_at=clock_timestamp()
   where id = $round and status = 'ARMED' and winner_id is null and arm_seq = $arm
   ```
   동시 요청은 행 잠금으로 직렬화되고, 먼저 커밋된 요청 이후의 요청은 WHERE 조건을 다시 평가해 0행이 됩니다. 추가로 `buzz_attempts`에 **부분 UNIQUE 인덱스**(`round_id WHERE accepted AND NOT revoked`)를 두어 로직이 틀리더라도 DB가 승자 2명을 거부합니다.
3. **판정 기준은 "서버 접수(직렬화) 순서"**. 클라이언트 타임스탬프는 사용하지 않습니다. 네트워크 지연 차이 때문에 실제 손가락 순서와 수십 ms 다를 수 있다는 점은 모든 부저 시스템의 물리적 한계이며, 사회자 화면에 접수 순서와 시간차(+0.035s 등)를 보여줘 박빙 상황을 판단할 수 있게 했습니다.
4. **멱등성**: `(round_id, arm_seq, participant_id)` UNIQUE → 연타·네트워크 재전송은 같은 결과를 돌려받을 뿐 시도가 늘지 않습니다. 클라이언트는 네트워크 오류 시 안전하게 자동 재시도합니다.
5. **round_id 검증**: 부저 요청에는 화면에 보이던 라운드 ID가 실립니다. 이미 끝난(FINISHED) 라운드나 다른 방의 라운드는 `STALE_ROUND`로 거절되어 다음 라운드에 절대 반영되지 않습니다.
6. **Realtime은 전파용일 뿐**: `rooms`, `rounds` 테이블의 변경을 postgres_changes로 받아 즉시 화면에 반영하고, 곧바로 RPC로 서버 상태를 재조회해 **최종 화면은 항상 서버 상태**가 되게 합니다. Realtime이 끊기면 2초 간격 polling으로 자동 전환되고, 3~5초 후 재구독을 시도합니다.

### 인증·보안 구조

| 대상 | 방식 |
| --- | --- |
| 참가자 | 입장 시 256-bit 랜덤 토큰 발급 → 브라우저 localStorage 보관. DB에는 **SHA-256 해시만** 저장(`private.participant_tokens`). 모든 참가자 RPC는 토큰으로 본인을 식별 → 다른 사람 ID로 누르기 불가 (API가 ID를 아예 받지 않음). |
| 사회자 | 비밀번호 bcrypt 해시를 `private.admin_config`에 저장(SQL 편집기에서만 설정). 로그인 시 24시간 세션 토큰 발급, 해시만 저장. 모든 `admin_*` RPC가 첫 줄에서 검증. 5분 내 10회 실패 시 로그인 잠금. |
| 테이블 | 전 테이블 RLS 활성화. anon은 `rooms`, `rounds`만 **SELECT**(Realtime용, 비밀 없음). `participants`, `buzz_attempts`, `private.*`는 접근 불가. INSERT/UPDATE/DELETE 권한 없음. |
| 함수 | 기본 EXECUTE 권한을 모두 회수한 뒤 공개 RPC만 허용 목록으로 부여. `private` 스키마는 API에 노출되지 않음. |
| 클라이언트 번들 | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`(공개용)만 포함. service_role 키·관리자 비밀번호는 어디에도 없음. |

> 참고: `rooms`/`rounds`는 공개 읽기이므로 방 코드·라운드 상태·우승자 닉네임은 누구나 볼 수 있습니다(대형 스크린과 동일한 정보). 참가자 목록·토큰은 공개되지 않습니다.

### 라운드 상태

```
WAITING ──준비──▶ READY ──부저 활성화──▶ ARMED ──첫 부저──▶ LOCKED(승자)
   │                                        │                  │
   └────────────부저 활성화─────────────────┘ └──잠금──▶ LOCKED(승자 없음) ──재활성화──▶ ARMED
다음 문제: 현재 라운드 → FINISHED, 새 라운드 READY 생성
우승 취소: 승자 제거 → LOCKED, 다시 활성화하면 취소된 사람은 그 문제에서 제외(오답 처리)
```

### 폴더 구조

```
buzzer/
├── supabase/migrations/20261024000000_buzzer.sql   # 스키마·RLS·RPC 전부
├── src/
│   ├── main.tsx, App.tsx, index.css                # 라우팅, 테마
│   ├── lib/
│   │   ├── supabase.ts        # 클라이언트, rpc() 래퍼, 한국어 오류 메시지
│   │   ├── participantView.ts # 서버 상태 → 참가자 화면 상태 (순수 함수)
│   │   ├── sound.ts           # Web Audio 효과음, iOS 잠금 해제, 진동
│   │   ├── csv.ts, storage.ts, types.ts
│   ├── hooks/
│   │   ├── useLiveSync.ts     # Realtime + polling fallback + 재연결
│   │   ├── useWakeLock.ts, useSound.ts
│   ├── components/            # Buzzer, Confetti, QrCode, ConnectionBadge, SoundToggle
│   └── pages/                 # ParticipantPage, AdminPage, DisplayPage
├── tests/
│   ├── db/                    # 실제 PostgreSQL 대상 통합·동시성·보안 테스트
│   └── unit/                  # 화면 상태, CSV
├── scripts/local-backend.mjs  # 로컬 리허설용 백엔드 (PostgREST RPC 호환)
├── docs/test-results.txt      # 최근 테스트 실행 결과
├── vercel.json, .env.example, vite.config.ts, vitest.config.ts
```

---

## 2. 로컬 실행

Node.js 20 이상이 필요합니다.

```bash
npm install
# embedded-postgres(테스트용) 바이너리 설치 스크립트 허용 — npm이 경고를 띄운 경우에만
npm approve-scripts @embedded-postgres/darwin-arm64   # 사용 중인 OS 패키지명으로
```

### A. Supabase 없이 바로 체험 (로컬 리허설 백엔드)

실제 PostgreSQL을 로컬에 띄우고 같은 마이그레이션을 적용합니다. Realtime 서버는 없으므로 앱은 **polling 모드**(배지: "연결됨 (폴링)")로 동작합니다.

```bash
npm run local:backend     # 터미널 1 — 관리자 비밀번호: localadmin123
npm run dev:local         # 터미널 2 — http://localhost:5173
```

같은 Wi-Fi의 휴대폰으로도 바로 테스트할 수 있습니다: Vite가 출력하는 `Network:` 주소(예: `http://192.168.0.10:5173`)로 사회자 화면을 열면 QR에도 그 주소가 들어갑니다(RPC 요청은 Vite 개발 서버가 로컬 백엔드로 프록시). 실제 행사 전 최종 리허설은 Realtime까지 확인할 수 있는 B 방법으로 하세요.

### B. Supabase 연결

```bash
cp .env.example .env.local   # 값 입력
npm run dev
```

---

## 3. Supabase 프로젝트 연결

1. [supabase.com](https://supabase.com)에서 새 프로젝트 생성 (리전: **Northeast Asia (Seoul)** 권장).
2. **SQL Editor** → `supabase/migrations/20261024000000_buzzer.sql` 전체를 붙여넣고 Run.
   (Supabase CLI 사용 시: `supabase link --project-ref <ref>` 후 `supabase db push`)
3. **관리자 비밀번호 설정** — SQL Editor에서 (8자 이상):
   ```sql
   select private.set_admin_password('여기에-강력한-비밀번호');
   ```
   비밀번호를 바꾸면 기존 관리자 세션은 모두 로그아웃됩니다. 이 SQL은 SQL Editor 기록에만 남으며 코드·환경변수에는 들어가지 않습니다.
4. **Realtime 확인**: Database → Publications → `supabase_realtime`에 `rooms`, `rounds`가 포함돼 있는지 확인(마이그레이션이 자동 추가).
5. **API 키**: Project Settings → API에서 `Project URL`과 `anon`(또는 publishable) 키를 복사해 `.env.local`/Vercel 환경변수에 입력. **service_role 키는 절대 사용하지 않습니다.**

---

## 4. Vercel 배포

1. 이 폴더를 GitHub 저장소로 push.
2. Vercel → New Project → 저장소 선택 (Framework: Vite 자동 인식, `vercel.json` 포함).
3. Environment Variables:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - (선택) `VITE_PUBLIC_BASE_URL` — 커스텀 도메인 사용 시
4. Deploy. `vercel.json`이 SPA 라우팅(`/admin`, `/room/ABCD` 새로고침)과 보안 헤더를 설정합니다.

CLI: `npx vercel` → `npx vercel --prod`

---

## 5. 행사 운영 가이드

### 행사 전날
- [ ] Vercel 주소로 `/admin` 로그인 → **새 퀴즈방 만들기** → 방 코드 확인
- [ ] QR 이미지 다운로드 → 테이블 안내문/슬라이드에 삽입 (방 코드는 행사 당일까지 그대로 유지 가능)
- [ ] **테스트 모드** ON → 봇 10~20명 추가 → 부저 활성화 → "봇 동시 부저"로 승자 1명 확인 → 테스트 모드 OFF(봇 자동 삭제)
- [ ] 휴대폰 2~3대(iPhone/Android, Wi-Fi/LTE 섞어서)로 실제 리허설
- [ ] 리허설 후 **관리 → 참가자 전체 초기화** (방 코드·QR 유지, 참가자·기록 삭제)

### 행사 당일 장비
- 사회자 노트북/태블릿: `/admin` (전원 연결, 절전 해제, 소리 켜기)
- 연회장 스크린: 별도 브라우저 창에서 **대형 스크린** 버튼 → `/display/방코드` 를 F11 전체화면. 한 번 클릭하면 효과음이 켜집니다.
- 호텔 Wi-Fi가 불안정하면 사회자 기기는 휴대폰 핫스팟 사용 권장.

### 진행 순서 (문제마다)
1. 문제를 읽기 전 **준비 (R)** → 참가자 화면에 "곧 시작합니다" + 초록 표시
2. 문제를 다 읽은 뒤 **부저 활성화 (A)** → 모든 부저가 빨갛게 바뀌고 시작음
3. 첫 부저가 서버에 접수되면 자동으로 잠기고 모든 화면에 "1등! ○○○"
4. 정답이면 **다음 문제 (N)**
   오답이면 **이번 우승 취소** → **부저 활성화** → 그 사람을 제외하고 다시 경쟁
5. 아무도 못 누르면 **잠금 (L)** 후 다음 문제

키보드 단축키 R / A / L / N 지원 (입력창에 커서가 없을 때).

### 참가자 안내 멘트 예시
> "테이블의 QR을 찍고 닉네임을 쓰면 입장! 빨간 버튼이 되면 누르세요. 아이폰은 **무음 스위치를 끄고**, 화면을 한 번 터치해야 소리가 나요."

### 문제 상황 대처
| 상황 | 대처 |
| --- | --- |
| 참가자가 "연결 끊김" | 자동 재연결됩니다. 오래 지속되면 새로고침 — 같은 닉네임으로 자동 복구 |
| 장난 닉네임 | 참가자 목록에서 **퇴장** (닉네임은 재사용 가능해짐) |
| 박빙 판정 시비 | 중앙의 접수 순서(+0.0xx초)를 근거로 안내 — 서버 접수 순서가 공식 기준 |
| 사회자 브라우저 새로고침/종료 | 다시 `/admin` 접속 시 세션·방 자동 복구 (24시간) |
| 잘못된 우승 기록 | 라운드별 우승 기록에서 **취소** |
| 기록 보관 | **CSV 다운로드** (엑셀 한글 호환) |
| 행사 종료 | **게임 종료** → 모든 화면 "게임 종료" + 개인별 1등 횟수 |

---

## 6. 테스트

```bash
npm test            # 전체 (unit + db)
npm run test:db     # 실제 PostgreSQL 대상 통합 테스트
npm run test:unit
npm run typecheck
```

DB 테스트는 `embedded-postgres`로 **실제 PostgreSQL 18 서버**를 띄우고, Supabase와 동일한 `anon`/`authenticated` 롤을 만든 뒤 **운영 마이그레이션 파일을 그대로 적용**합니다. 모든 호출은 `anon` 롤 연결로 수행되어 브라우저와 같은 권한에서 검증합니다. 동시성 테스트는 휴대폰 1대 = DB 연결 1개로 시뮬레이션합니다.

최근 결과: **36 / 36 통과** (4회 연속 실행) — 전체 로그 `docs/test-results.txt`

### 요구 시나리오별 검증 현황

| # | 시나리오 | 방법 | 결과 |
| --- | --- | --- | --- |
| 1 | 20명 동시 접속 | 20개 연결 동시 `join_room`, 토큰 원문 미저장 확인 | ✅ 자동 |
| 2 | 닉네임 중복 | 대소문자·공백 무시 중복 거부, **같은 닉네임 8명 동시 입장 → 1명만 성공**, 12자 제한 | ✅ 자동 |
| 3 | 10명 거의 동시 부저 | 10연결 동시 → 승자 1명, 9명 같은 승자 통보. **스트레스: 40라운드 × 20명(각자 2연타)**. **승자가 커밋 전 0.2초 락을 쥐고 있는 상황**에서도 1명. DB 제약이 2번째 승자 INSERT 거부 | ✅ 자동 |
| 4 | 같은 사람 5연타 | 5개 동시 요청 → 시도 기록 1건, 5번 모두 WON(멱등). 패자 반복 → 계속 LOST | ✅ 자동 (테스트가 실제 버그 1건 발견·수정: 본인 중복 요청이 LOST로 응답되던 문제) |
| 5 | 시작 전 누르기 | WAITING/READY에서 `NOT_ARMED`, 기록 없음, 이후 정상 참여 가능 | ✅ 자동 |
| 6 | 승자 확정 후 누르기 | `LOST` + 승자 불변, 승자 있는 라운드 재활성화 거부 | ✅ 자동 |
| 7 | 다음 라운드 직전 이전 요청 | 이전 round_id 요청 → `STALE_ROUND`. **NEXT+ARM과 이전 라운드 부저 동시 발사 10회** → 새 라운드 무영향. 관리자 NEXT 더블클릭 → 라운드 건너뜀 없음 | ✅ 자동 |
| 8 | 참가자 새로고침 | 새 연결에서 토큰만으로 신원·라운드·내 시도 상태 복구 (+ 브라우저 실측) | ✅ 자동 + 수동 |
| 9 | Wi-Fi → 모바일 데이터 | 인증이 IP/연결이 아닌 토큰 기반 → 새 연결에서 동일 복구(8번과 동일 경로). 클라이언트는 `online`/`visibilitychange` 이벤트로 즉시 재동기화 | ✅ 자동(서버 측) / ⚠️ 실기기 확인 필요 |
| 10 | 사회자 새로고침 | 세션 토큰으로 상태·접수 순서·우승 횟수 복구 | ✅ 자동 + 수동 |
| 11 | Realtime 끊김/복구 | 로컬 백엔드(Realtime 없음)에서 polling 모드로 전 흐름 동작 브라우저 실측. 재구독 로직은 코드 리뷰 수준 | ⚠️ 실제 Supabase에서 확인 필요 |
| 12 | 토큰 위조·관리자 API 무단 호출 | 위조/잘린/빈 토큰 거부, 다른 방 부저 거부, **13개 관리자 RPC × 4종 위조 토큰 전부 거부**, 무차별 대입 잠금, 만료·로그아웃, anon의 테이블 직접 읽기/쓰기·private 함수 호출 전부 `permission denied` | ✅ 자동 |

### 브라우저 실측 (로컬 백엔드, Chrome)
관리자 로그인 → 방 생성/QR → 참가자 입장 → WAITING → 부저 활성화(단축키) → ARMED → 부저 → 금색 우승 화면+컨페티 → 관리자 우승자 대형 표시·반응 시간 → 다음 문제 → 다른 참가자 승리 시 "지우님이 먼저 눌렀습니다" → 새로고침 복구 → `/display` 표시, 중복 닉네임 거부까지 확인했습니다.
이 과정에서 발견해 수정한 문제: ① 백그라운드 탭에서 polling이 멈추던 문제(이제 3배 느리게 계속), ② 페이지 첫 로드 시 기존 우승자에 축하 효과가 재생되던 문제.

### 행사 전 반드시 직접 확인할 것 (자동화 불가)
- 실제 Supabase Realtime 연결 상태 배지가 **"실시간"(초록)** 으로 뜨는지
- iPhone Safari / Android Chrome에서 효과음·진동 (iPhone은 진동 API 미지원 — 시각 효과로 대체됨)
- 휴대폰 Wi-Fi 끄기 → LTE 전환 → 자동 복구
- 휴대폰 화면 껐다 켜기 → 상태 즉시 갱신

---

## 7. 알려진 제약

- **판정 공정성**: 서버 접수 순서 기준이므로 LTE와 Wi-Fi 사용자 간 수십 ms 차이가 생길 수 있습니다(모든 네트워크 부저의 공통 한계). 사회자 화면의 시간차로 판단을 돕습니다.
- **iOS**: 무음 모드에서는 Web Audio 소리가 나지 않으며 진동 API가 없습니다. 화면 플래시·애니메이션으로 대체됩니다. 화면 꺼짐 방지(Wake Lock)는 iOS 16.4+에서 동작합니다.
- **테스트 봇**은 생성한 관리자 브라우저 메모리에만 토큰이 있어, 새로고침 후에는 삭제 후 다시 추가해야 합니다.
- `/display`와 `/join`에서 방 코드를 생략하면 가장 최근의 진행 중인 방을 사용합니다.
