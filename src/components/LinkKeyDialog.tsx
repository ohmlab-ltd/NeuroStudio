import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { useObservable } from "../state/observable";
import { answerLinkKey, linkKeyRequest, linkKeyValid, type LinkKeyRequest } from "../state/linkKey";

export function LinkKeyCard({
  request,
  onAnswer,
}: {
  request: LinkKeyRequest;
  onAnswer(key: string | null): void;
}) {
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const ok = linkKeyValid(key);

  return (
    <form
      className="dialog-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="link-key-title"
      onSubmit={(event) => {
        event.preventDefault();
        if (ok) onAnswer(key);
      }}
    >
      <header id="link-key-title">
        <Icon name="lock" size={16} />
        Link key
      </header>
      <p>
        {`The board at ${request.host} sends its stream only to a host that knows its link ` +
          "key: the key its sketch sets with WiFi.setLinkKey(), or one stored with its WiFi " +
          "settings. Neuro Studio keeps it until this window closes."}
      </p>
      {request.wrong ? (
        <p className="dialog-error">The board refused the key it was given.</p>
      ) : null}
      <div className="dialog-field">
        <input
          className="text-input"
          type={show ? "text" : "password"}
          aria-label="Link key"
          placeholder="8 to 64 bytes"
          autoFocus
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        <button type="button" className="button quiet small" onClick={() => setShow((v) => !v)}>
          {show ? "Hide" : "Show"}
        </button>
      </div>
      <div className="dialog-actions">
        <span className="spacer" />
        <button type="button" className="button quiet" onClick={() => onAnswer(null)}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={!ok}>
          Connect
        </button>
      </div>
    </form>
  );
}

export function LinkKeyDialog() {
  const request = useObservable(linkKeyRequest);

  useEffect(() => {
    if (!request) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") answerLinkKey(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [request]);

  if (!request) return null;
  // No cancel on a click outside, which would discard a half-typed key.
  return createPortal(
    <div className="dialog-backdrop">
      <LinkKeyCard
        key={`${request.host}:${request.wrong}`}
        request={request}
        onAnswer={answerLinkKey}
      />
    </div>,
    document.body,
  );
}
