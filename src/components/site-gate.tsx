"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { WORKFLOW_COPY } from "@/lib/local-ai/copy-workflow";
import type { StudioLanguage } from "@/lib/studio-types";
import styles from "./workflow-panels.module.css";

type Access =
  | { phase: "checking" }
  | { phase: "open"; required: boolean }
  | { phase: "locked" }
  | { phase: "misconfigured" };

type Props = { language: StudioLanguage; children: ReactNode };

// Shows the studio only after sign-in when the server requires it (SMASHLAB_SITE_PASSWORD). Without a site
// password the studio opens directly, which is the local development setup.
export function SiteGate({ language, children }: Props) {
  const copy = WORKFLOW_COPY[language];
  const [access, setAccess] = useState<Access>({ phase: "checking" });
  const [password, setPassword] = useState("");
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/session", { cache: "no-store" }).then(
      async (response) => {
        if (!active) return;
        if (response.status === 503) {
          setAccess({ phase: "misconfigured" });
          return;
        }
        const body = (await response.json()) as { required: boolean; authenticated: boolean };
        setAccess(body.required && !body.authenticated ? { phase: "locked" } : { phase: "open", required: body.required });
      },
      () => {
        if (active) setAccess({ phase: "open", required: false });
      },
    );
    return () => {
      active = false;
    };
  }, []);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setFailed(false);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (response.ok) {
        setPassword("");
        setAccess({ phase: "open", required: true });
      } else {
        setFailed(true);
      }
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    setAccess({ phase: "locked" });
  }

  if (access.phase === "checking") return <p className={styles.gateNote}>{copy.accessChecking}</p>;
  if (access.phase === "misconfigured") return <p className={styles.gateNote}>{copy.accessMisconfigured}</p>;
  if (access.phase === "locked") {
    return (
      <section className={styles.gate} aria-labelledby="sign-in-title">
        <h2 id="sign-in-title">{copy.signInTitle}</h2>
        <p className={styles.muted}>{copy.signInBody}</p>
        <form onSubmit={signIn} className={styles.gateForm}>
          <label className={styles.field}>
            <span>{copy.signInPassword}</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
              required
            />
          </label>
          <button type="submit" className={styles.primaryButton} disabled={busy || password.length === 0}>
            {copy.signInButton}
          </button>
          {failed ? <p role="alert" className={styles.noticeError}>{copy.signInFailed}</p> : null}
        </form>
      </section>
    );
  }
  return (
    <>
      {access.required ? (
        <div className={styles.signOutBar}>
          <button type="button" className={styles.ghostButton} onClick={signOut}>{copy.signOut}</button>
        </div>
      ) : null}
      {children}
    </>
  );
}
