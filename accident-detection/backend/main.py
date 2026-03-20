import cv2
import numpy as np
import base64
import json
import os
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from datetime import datetime
from detector import AccidentDetector
from database import save_detection, get_recent_events

app      = FastAPI(title="Accident Detection API")
detector = AccidentDetector("../model/weights/best.pt")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

connected_clients: list[WebSocket] = []
last_alert_time   = 0
ALERT_COOLDOWN    = 12

# Temporal filter — require 5 consecutive detections above 0.75
CONSECUTIVE_NEEDED = 2
consecutive_count  = 0
last_live_result   = None

async def safe_notify(confidence: float, severity: str):
    message = json.dumps({
        "type":       "ACCIDENT_ALERT",
        "confidence": confidence,
        "severity":   severity,
        "timestamp":  datetime.utcnow().isoformat(),
        "location":   "Main Road - CAM_01"
    })
    dead = []
    for client in connected_clients:
        try:
            await client.send_text(message)
        except Exception:
            dead.append(client)
    for c in dead:
        try: connected_clients.remove(c)
        except: pass

@app.get("/")
def root():
    return {"status": "Accident Detection API running"}

@app.post("/detect")
async def detect_image(file: UploadFile = File(...)):
    """Used by video player for frame-by-frame detection."""
    contents = await file.read()
    np_arr   = np.frombuffer(contents, np.uint8)
    frame    = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
    if frame is None:
        return JSONResponse({
            "accident_detected": False,
            "confidence": 0.0,
            "severity": "none",
            "annotated_frame": ""
        })

    result = detector.detect(frame)

    # Only alert for high-confidence detections in video mode
    if result["accident_detected"] and result["confidence"] >= 0.55:
        save_detection(result["confidence"])
        await safe_notify(result["confidence"], result["severity"])

    _, buffer = cv2.imencode(".jpg", result["annotated_frame"])
    return JSONResponse({
        "accident_detected": result["accident_detected"],
        "confidence":        result["confidence"],
        "severity":          result["severity"],
        "annotated_frame":   base64.b64encode(buffer).decode("utf-8")
    })

@app.get("/live-stream")
async def live_stream():
    """MJPEG webcam stream — pure sync, no await."""
    def generate_frames():
        global consecutive_count, last_live_result

        cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)
        if not cap.isOpened():
            cap = cv2.VideoCapture(0)
        if not cap.isOpened():
            print("ERROR: Cannot open webcam")
            return

        cap.set(cv2.CAP_PROP_FRAME_WIDTH,  640)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        cap.set(cv2.CAP_PROP_FPS,          15)
        cap.set(cv2.CAP_PROP_BUFFERSIZE,   1)
        consecutive_count = 0

        frame_idx   = 0
        last_result = None

        try:
            while True:
                ret, frame = cap.read()
                if not ret:
                    break

                # Run detection every 3rd frame
                if frame_idx % 3 == 0:
                    last_result = detector.detect(frame)

                    if (last_result
                            and last_result["accident_detected"]
                            and last_result["confidence"] >= 0.55):
                        consecutive_count += 1
                    else:
                        consecutive_count = 0

                display = last_result["annotated_frame"] if last_result else frame

                # Timestamp overlay
                ts = datetime.now().strftime("%d/%m/%Y %H:%M:%S IST")
                cv2.putText(display, f"CAM_01 | {ts}",
                            (10, display.shape[0]-10),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255,255,255), 1)

                # Confirmed = 5 consecutive frames detected
                confirmed = (
                    last_result is not None
                    and last_result["accident_detected"]
                    and last_result["confidence"] >= 0.75
                    and consecutive_count >= CONSECUTIVE_NEEDED
                )

                last_live_result = {
                    "accident_detected": confirmed,
                    "raw_detected":      last_result["accident_detected"] if last_result else False,
                    "confidence":        last_result["confidence"] if last_result else 0.0,
                    "severity":          last_result["severity"]   if last_result else "none",
                    "consecutive":       consecutive_count,
                    "timestamp":         datetime.utcnow().isoformat()
                }

                _, buffer = cv2.imencode(
                    ".jpg", display,
                    [cv2.IMWRITE_JPEG_QUALITY, 75]
                )
                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n\r\n"
                    + buffer.tobytes()
                    + b"\r\n"
                )
                frame_idx += 1

        except Exception as e:
            print(f"Stream error: {e}")
        finally:
            cap.release()
            last_live_result = None
            print("Webcam released")

    return StreamingResponse(
        generate_frames(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma":        "no-cache",
            "Expires":       "0"
        }
    )

@app.get("/live-status")
async def live_status():
    """Frontend polls this every second for detection state."""
    global last_alert_time, last_live_result

    if last_live_result is None:
        return JSONResponse({
            "accident_detected": False,
            "confidence": 0.0,
            "severity": "none",
            "consecutive": 0
        })

    now = datetime.utcnow().timestamp()
    if (last_live_result["accident_detected"]
            and last_live_result["confidence"] >= 0.75
            and (now - last_alert_time) > ALERT_COOLDOWN):
        last_alert_time = now
        save_detection(last_live_result["confidence"])
        await safe_notify(last_live_result["confidence"], last_live_result["severity"])

    return JSONResponse(last_live_result)

@app.get("/events")
def get_events():
    return [
        {
            "id":         e.id,
            "timestamp":  e.timestamp.isoformat(),
            "confidence": e.confidence,
            "camera_id":  e.camera_id,
            "location":   e.location
        }
        for e in get_recent_events()
    ]

@app.websocket("/ws/alerts")
async def websocket_alerts(websocket: WebSocket):
    await websocket.accept()
    connected_clients.append(websocket)
    print(f"Client connected. Total: {len(connected_clients)}")
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        try: connected_clients.remove(websocket)
        except: pass
        print(f"Client disconnected. Total: {len(connected_clients)}")