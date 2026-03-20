import cv2
from ultralytics import YOLO

class AccidentDetector:
    def __init__(self, weights_path="../model/weights/best.pt"):
        self.model = YOLO(weights_path)
        self.confidence_threshold = 0.50
        print(f"Model loaded from {weights_path}")

    def detect(self, frame):
        results = self.model(frame, conf=self.confidence_threshold, verbose=False)
        accident_detected = False
        confidence = 0.0
        severity = "none"
        annotated_frame = frame.copy()

        for result in results:
            for box in result.boxes:
                cls_id     = int(box.cls[0])
                conf_score = float(box.conf[0])
                label      = self.model.names[cls_id]

                if label == "accident":
                    accident_detected = True
                    confidence = max(confidence, conf_score)

                    if conf_score >= 0.90:
                        severity = "critical"
                        color    = (0, 0, 255)
                        tag      = f"CRITICAL {conf_score:.0%}"
                    elif conf_score >= 0.75:
                        severity = "warning"
                        color    = (0, 140, 255)
                        tag      = f"ACCIDENT {conf_score:.0%}"
                    else:
                        severity = "low"
                        color    = (0, 215, 255)
                        tag      = f"POSSIBLE {conf_score:.0%}"

                    x1, y1, x2, y2 = map(int, box.xyxy[0])
                    overlay = annotated_frame.copy()
                    cv2.rectangle(overlay, (x1, y1-28), (x2, y1), color, -1)
                    cv2.addWeighted(overlay, 0.6, annotated_frame, 0.4, 0, annotated_frame)
                    cv2.rectangle(annotated_frame, (x1, y1), (x2, y2), color, 3)
                    cv2.putText(annotated_frame, tag, (x1+4, y1-8),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255,255,255), 2)

        return {
            "accident_detected": accident_detected,
            "confidence":        round(confidence, 3),
            "severity":          severity,
            "annotated_frame":   annotated_frame
        }