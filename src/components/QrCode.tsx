import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export function useQrDataUrl(text: string, width = 640) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(text, { width, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0a1230', light: '#ffffff' } })
      .then((u) => alive && setUrl(u))
      .catch(() => alive && setUrl(null));
    return () => {
      alive = false;
    };
  }, [text, width]);
  return url;
}

export function QrCode({ text, size = 160, downloadName }: { text: string; size?: number; downloadName?: string }) {
  const url = useQrDataUrl(text);
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="rounded-xl bg-white p-2" style={{ width: size + 16, height: size + 16 }}>
        {url ? <img src={url} width={size} height={size} alt={`참가 QR 코드: ${text}`} /> : null}
      </div>
      {downloadName && url && (
        <a href={url} download={downloadName} className="text-xs font-bold text-amber-300 underline underline-offset-2">
          QR 이미지 다운로드
        </a>
      )}
    </div>
  );
}
