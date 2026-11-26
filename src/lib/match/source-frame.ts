// One frame of the analysis's own video, drawn in the browser. The frame is read from the source file the job analysed
// (the same server-side file, through the same origin), so nothing is generated or invented. Returns null while loading,
// and when the browser cannot read the video.
import { useEffect, useState } from "react";
import { frameSeekTime } from "./shot-trajectory";

const CACHE_LIMIT = 24;
const cache = new Map<string, string>();

function remember(key: string, dataUrl: string): void {
  cache.set(key, dataUrl);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

export function useSourceFrame(url: string | null, frame: number, fps: number, enabled: boolean): string | null {
  const key = url && enabled ? `${url}#${frame}` : null;
  const [ready, setReady] = useState<{ key: string; dataUrl: string } | null>(null);

  useEffect(() => {
    if (!key || !url || cache.has(key)) return;
    let cancelled = false;
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.playsInline = true;
    const release = () => {
      video.removeAttribute("src");
      video.load();
    };
    video.onloadedmetadata = () => {
      video.currentTime = frameSeekTime(frame, fps);
    };
    video.onseeked = () => {
      if (cancelled) return;
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d");
      if (context && canvas.width > 0 && canvas.height > 0) {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        try {
          const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
          remember(key, dataUrl);
          setReady({ key, dataUrl });
        } catch {
          // The canvas could not be read back: the trajectory is shown without a background.
        }
      }
      release();
    };
    video.onerror = () => release();
    video.src = url;
    return () => {
      cancelled = true;
      release();
    };
  }, [key, url, frame, fps]);

  if (!key) return null;
  const cached = cache.get(key);
  if (cached) return cached;
  return ready && ready.key === key ? ready.dataUrl : null;
}
