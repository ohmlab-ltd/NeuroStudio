import { useEffect, useRef } from "react";
import { PanelFrame, type SlotControls } from "../PanelFrame";
import { EmptyState } from "../controls";
import { useObservable } from "../../state/observable";
import { connection, visionFrame, visionKind } from "../../state/device";
import { buildEvidenceSubscriptionPacket, kEvidenceCrop } from "../../device/packets";
import {
  kVisionKindAprilTag,
  kVisionKindBarcode,
  kVisionKindBlob,
  kVisionKindQr,
  visionCropToRgba,
  type TagPose,
  type VisionResult,
} from "../../device/tlv";

/** The board drops the subscription after 3 s. */
const EVIDENCE_RENEW_MS = 1000;

function CropThumbnail({ result }: { result: VisionResult }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const rgba = visionCropToRgba(result);
    // A reused row with no crop yet shows an empty box, not the previous picture.
    if (!rgba) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    canvas.width = result.cropW;
    canvas.height = result.cropH;
    ctx.putImageData(new ImageData(rgba, result.cropW, result.cropH), 0, 0);
  }, [result]);

  return (
    <div className="vision-crop">
      <canvas ref={ref} />
    </div>
  );
}

export function kindLabel(kind: number): string {
  if (kind === kVisionKindQr) return "QR CODE";
  if (kind === kVisionKindBarcode) return "BARCODE";
  if (kind === kVisionKindBlob) return "COLOUR BLOB";
  if (kind === kVisionKindAprilTag) return "APRILTAG";
  return "VISION";
}

export function formatTagPose(pose: TagPose): [string, string] {
  return [
    `x ${pose.tx.toFixed(3)}  y ${pose.ty.toFixed(3)}  z ${pose.tz.toFixed(3)} m`,
    `rx ${pose.rx.toFixed(0)}  ry ${pose.ry.toFixed(0)}  rz ${pose.rz.toFixed(0)} deg`,
  ];
}

/** One entry per holder: two Vision panels can be open at once. */
const evidenceHolds: number[] = [];
let evidenceTimer: ReturnType<typeof setInterval> | null = null;

/** The union of every held mask, 0 when none. Nothing is sent while disconnected. */
function sendEvidenceSubscription(): void {
  if (!connection.get().connected) return;
  const mask = evidenceHolds.reduce((all, m) => all | m, 0);
  window.neuro.write(buildEvidenceSubscriptionPacket(mask));
}

/** Holds `mask` until the returned release is called; the last release sends mask 0. */
export function holdEvidenceSubscription(mask: number): () => void {
  evidenceHolds.push(mask);
  sendEvidenceSubscription();
  evidenceTimer ??= setInterval(sendEvidenceSubscription, EVIDENCE_RENEW_MS);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    evidenceHolds.splice(evidenceHolds.indexOf(mask), 1);
    if (evidenceHolds.length === 0 && evidenceTimer !== null) {
      clearInterval(evidenceTimer);
      evidenceTimer = null;
    }
    sendEvidenceSubscription();
  };
}

export function VisionPanel({ controls }: { controls: SlotControls }) {
  const frame = useObservable(visionFrame);
  const kind = useObservable(visionKind);
  useEffect(() => holdEvidenceSubscription(kEvidenceCrop), []);

  return (
    <PanelFrame title={kindLabel(kind)} controls={controls}>
      <div className="panel-body">
        {!frame ? (
          <EmptyState>Waiting for the first result</EmptyState>
        ) : frame.results.length === 0 ? (
          <EmptyState>Nothing in view</EmptyState>
        ) : (
          frame.results.map((result, index) => (
            <div className="vision-result" key={`${index}-${result.text}`}>
              <CropThumbnail result={result} />
              <div className="vision-text">
                {result.text ? <div className="vision-payload">{result.text}</div> : null}
                {result.detail ? <div className="vision-detail">{result.detail}</div> : null}
                {result.pose
                  ? formatTagPose(result.pose).map((line, i) => (
                      <div className="vision-pose" key={i}>
                        {line}
                      </div>
                    ))
                  : null}
                <div className="vision-pos">
                  {`x ${(result.cx * 100).toFixed(0)}%  y ${(result.cy * 100).toFixed(0)}%`}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </PanelFrame>
  );
}
