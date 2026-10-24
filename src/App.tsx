import { Navigate, Route, Routes } from 'react-router-dom';
import { isConfigured } from './lib/supabase';
import { AdminPage } from './pages/AdminPage';
import { DisplayPage } from './pages/DisplayPage';
import { ParticipantPage } from './pages/ParticipantPage';

export function App() {
  if (!isConfigured) {
    return (
      <main className="stage flex min-h-dvh items-center justify-center p-6 text-center">
        <div className="max-w-md space-y-3">
          <h1 className="font-display text-3xl text-amber-300">설정이 필요합니다</h1>
          <p className="text-white/80">
            VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 환경변수가 없습니다. <code>.env.example</code>을 참고해 설정해 주세요.
          </p>
        </div>
      </main>
    );
  }
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/join" replace />} />
      <Route path="/join" element={<ParticipantPage />} />
      <Route path="/room/:roomCode" element={<ParticipantPage />} />
      <Route path="/admin" element={<AdminPage />} />
      <Route path="/display" element={<DisplayPage />} />
      <Route path="/display/:roomCode" element={<DisplayPage />} />
      <Route path="*" element={<Navigate to="/join" replace />} />
    </Routes>
  );
}
