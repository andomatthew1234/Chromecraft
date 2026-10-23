import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";

import type { WebsiteControlSnapshot } from "../shared/browser";
import type {
  OfflinePageEntrySnapshot,
  OfflinePagesSnapshot,
} from "../shared/offline-pages";
import { SiteControlsPanel } from "./SiteControlsPanel";
import "./page-actions.css";

type PageActionView = "menu" | "security" | "save" | "share" | "qr";
type SaveState =
  | { stage: "idle" | "saving"; entry: null; error: null }
  | { stage: "saved"; entry: OfflinePageEntrySnapshot; error: null }
  | { stage: "failed"; entry: null; error: string };

function MaterialIcon({ name }: { name: string }) {
  return (
    <span className="material-symbols-rounded" aria-hidden="true">
      {name}
    </span>
  );
}

function Header({
  title,
  detail,
  back,
  close,
}: {
  title: string;
  detail: string;
  back?: () => void;
  close: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [title]);
  return (
    <header className="page-actions-header">
      {back ? (
        <button
          type="button"
          className="page-actions-icon-button"
          aria-label="Back to page actions"
          onClick={back}
        >
          <MaterialIcon name="arrow_back" />
        </button>
      ) : (
        <span className="page-actions-identity" aria-hidden="true">
          <MaterialIcon name="info" />
        </span>
      )}
      <span className="page-actions-heading-copy">
        <h2 ref={heading} tabIndex={-1}>
          {title}
        </h2>
        <small>{detail}</small>
      </span>
      <button
        type="button"
        className="page-actions-icon-button"
        aria-label="Close page actions"
        onClick={close}
      >
        <MaterialIcon name="close" />
      </button>
    </header>
  );
}

export function PageActionsPanel({
  tabId,
  pageTitle,
  pageUrl,
  site,
  close,
  manageSecurity,
}: {
  tabId: string;
  pageTitle: string;
  pageUrl: string;
  site: WebsiteControlSnapshot;
  close: () => void;
  manageSecurity: () => void;
}) {
  const [view, setView] = useState<PageActionView>("menu");
  const [saveState, setSaveState] = useState<SaveState>({
    stage: "idle",
    entry: null,
    error: null,
  });
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [copyLabel, setCopyLabel] = useState("Copy link");

  useEffect(() => {
    const sync = (snapshot: OfflinePagesSnapshot) => {
      if (snapshot.save.tabId !== tabId) return;
      if (snapshot.save.stage === "saving") {
        setSaveState({ stage: "saving", entry: null, error: null });
        return;
      }
      if (snapshot.save.stage === "complete" && snapshot.save.entryId) {
        const entry = snapshot.items.find(
          (item) => item.id === snapshot.save.entryId,
        );
        if (entry) setSaveState({ stage: "saved", entry, error: null });
        return;
      }
      if (snapshot.save.stage === "failed") {
        setSaveState({
          stage: "failed",
          entry: null,
          error: snapshot.save.error ?? "The page could not be saved.",
        });
      }
    };
    let active = true;
    void window.chromecraft
      .getOfflinePages()
      .then((snapshot) => {
        if (active) sync(snapshot);
      })
      .catch(() => undefined);
    const unsubscribe = window.chromecraft.onOfflinePages(sync);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [tabId]);

  useEffect(() => {
    if (view !== "qr" || qrDataUrl || qrError) return;
    let active = true;
    void QRCode.toDataURL(pageUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 320,
      color: { dark: "#151719ff", light: "#ffffffff" },
    })
      .then((value) => {
        if (active) setQrDataUrl(value);
      })
      .catch(() => {
        if (active) setQrError("The QR code could not be generated.");
      });
    return () => {
      active = false;
    };
  }, [pageUrl, qrDataUrl, qrError, view]);

  const savePage = () => {
    if (saveState.stage === "saving") return;
    setView("save");
    setSaveState({ stage: "saving", entry: null, error: null });
    void window.chromecraft
      .savePageForOffline(tabId)
      .then((entry) => setSaveState({ stage: "saved", entry, error: null }))
      .catch((error: unknown) =>
        setSaveState({
          stage: "failed",
          entry: null,
          error:
            error instanceof Error
              ? error.message
              : "The page could not be saved.",
        }),
      );
  };

  const copyLink = () => {
    const resetLabel = () =>
      window.setTimeout(() => setCopyLabel("Copy link"), 1800);
    if (!navigator.clipboard) {
      setCopyLabel("Couldn’t copy");
      resetLabel();
      return;
    }
    void navigator.clipboard
      .writeText(pageUrl)
      .then(() => setCopyLabel("Copied"))
      .catch(() => setCopyLabel("Couldn’t copy"))
      .finally(resetLabel);
  };

  if (view === "security") {
    return (
      <SiteControlsPanel
        site={site}
        close={close}
        back={() => setView("menu")}
        manage={manageSecurity}
      />
    );
  }

  return (
    <section
      className="page-actions-popover"
      role="dialog"
      aria-modal="false"
      aria-label="Page actions"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        if (view === "menu") close();
        else setView("menu");
      }}
    >
      {view === "menu" && (
        <>
          <Header title={site.hostname} detail="Page actions" close={close} />
          <div className="page-actions-list">
            <button
              type="button"
              className="page-action-row"
              onClick={() => setView("security")}
            >
              <span className="page-action-row-icon">
                <MaterialIcon name="lock" />
              </span>
              <span>
                <strong>Page Security</strong>
                <small>Connection, permissions and site data</small>
              </span>
              <MaterialIcon name="chevron_right" />
            </button>
            <button
              type="button"
              className="page-action-row"
              onClick={() => {
                if (saveState.stage === "saving") setView("save");
                else savePage();
              }}
            >
              <span className="page-action-row-icon">
                <MaterialIcon name="download" />
              </span>
              <span>
                <strong>Save for later</strong>
                <small>
                  {saveState.stage === "saving"
                    ? "Saving this page now…"
                    : "Keep a static copy available offline"}
                </small>
              </span>
              <MaterialIcon name="chevron_right" />
            </button>
            <button
              type="button"
              className="page-action-row"
              onClick={() => setView("share")}
            >
              <span className="page-action-row-icon">
                <MaterialIcon name="share" />
              </span>
              <span>
                <strong>Share page</strong>
                <small>Share without trackers or branding</small>
              </span>
              <MaterialIcon name="chevron_right" />
            </button>
          </div>
        </>
      )}

      {view === "save" && (
        <>
          <Header
            title="Save for later"
            detail={site.hostname}
            back={() => setView("menu")}
            close={close}
          />
          <div className="page-save-state" data-stage={saveState.stage}>
            <span className="page-save-hero" aria-hidden="true">
              <MaterialIcon
                name={
                  saveState.stage === "saved"
                    ? "download_done"
                    : saveState.stage === "failed"
                      ? "error"
                      : "cloud_download"
                }
              />
            </span>
            {saveState.stage === "saving" && (
              <>
                <h3>Saving this page</h3>
                <p>Collecting the page, styles, images and loaded resources…</p>
                <span className="page-save-progress" role="progressbar" />
              </>
            )}
            {saveState.stage === "saved" && (
              <>
                <h3>Ready offline</h3>
                <p>
                  The page is now in Offline Pages. Scripts and live server
                  features stay disabled in the saved copy for safety.
                </p>
                <button
                  type="button"
                  className="page-actions-filled-button"
                  onClick={() => {
                    close();
                    void window.chromecraft.openOfflinePages(
                      saveState.entry.id,
                    );
                  }}
                >
                  Open Offline Pages
                </button>
              </>
            )}
            {saveState.stage === "failed" && (
              <>
                <h3>Couldn’t save this page</h3>
                <p role="alert">{saveState.error}</p>
                <button
                  type="button"
                  className="page-actions-filled-button"
                  onClick={savePage}
                >
                  Try again
                </button>
              </>
            )}
          </div>
        </>
      )}

      {view === "share" && (
        <>
          <Header
            title="Share page"
            detail={site.hostname}
            back={() => setView("menu")}
            close={close}
          />
          <div className="page-actions-list">
            <button
              type="button"
              className="page-action-row"
              onClick={() => setView("qr")}
            >
              <span className="page-action-row-icon">
                <MaterialIcon name="qr_code_2" />
              </span>
              <span>
                <strong>Create QR</strong>
                <small>Generated locally, with no ads or branding</small>
              </span>
              <MaterialIcon name="chevron_right" />
            </button>
          </div>
        </>
      )}

      {view === "qr" && (
        <>
          <Header
            title="Create QR"
            detail="Generated privately on this device"
            back={() => setView("share")}
            close={close}
          />
          <div className="page-qr-view">
            {qrDataUrl ? (
              <img src={qrDataUrl} alt={`QR code for ${pageUrl}`} />
            ) : qrError ? (
              <p role="alert">{qrError}</p>
            ) : (
              <span className="page-qr-loading" role="progressbar" />
            )}
            <strong>{pageTitle || site.hostname}</strong>
            <small>{pageUrl}</small>
            {qrDataUrl && (
              <div className="page-qr-actions">
                <button type="button" onClick={copyLink}>
                  <MaterialIcon name="content_copy" />
                  {copyLabel}
                </button>
                <a href={qrDataUrl} download="chromecraft-page-qr.png">
                  <MaterialIcon name="download" />
                  Save QR
                </a>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
