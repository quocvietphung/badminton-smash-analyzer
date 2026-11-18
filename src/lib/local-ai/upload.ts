// Sends one video straight to the backend, using the upload ticket from /api/upload-session. XMLHttpRequest is used
// because it reports upload progress, which fetch cannot. Failures keep the backend's error code and message.
import { LocalAiApiError, parseLocalAiError, type LocalAiJob } from "./client";

export type UploadSession = {
  ticket: string | null;
  expiresAt: number | null;
  maxBytes: number;
  mode: string;
  uploadUrl: string;
};

export const UPLOAD_OFFLINE_CODE = "backend_offline";

export function sendVideo(
  session: UploadSession,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<LocalAiJob> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", session.uploadUrl);
    if (session.ticket) xhr.setRequestHeader("X-SmashLab-Upload-Ticket", session.ticket);
    xhr.responseType = "text";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    xhr.onerror = () => {
      reject(new LocalAiApiError(0, UPLOAD_OFFLINE_CODE, "Local AI backend offline. Start Docker on the Mac."));
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve(body as LocalAiJob);
        return;
      }
      const error = parseLocalAiError(xhr.status, body);
      reject(new LocalAiApiError(xhr.status, error.code, error.message));
    };
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
}
