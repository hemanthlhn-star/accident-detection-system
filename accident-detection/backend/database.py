from sqlalchemy import create_engine, Column, Integer, Float, String, DateTime
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from datetime import datetime

DATABASE_URL = "sqlite:///./accidents.db"
engine       = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine)
Base         = declarative_base()

class DetectionEvent(Base):
    __tablename__ = "detection_events"
    id         = Column(Integer, primary_key=True, index=True)
    timestamp  = Column(DateTime, default=datetime.utcnow)
    confidence = Column(Float)
    camera_id  = Column(String, default="CAM_01")
    location   = Column(String, default="Main Road")

Base.metadata.create_all(bind=engine)

def save_detection(confidence: float, camera_id: str = "CAM_01"):
    db = SessionLocal()
    event = DetectionEvent(confidence=confidence, camera_id=camera_id)
    db.add(event)
    db.commit()
    db.close()

def get_recent_events(limit: int = 20):
    db = SessionLocal()
    events = db.query(DetectionEvent)\
               .order_by(DetectionEvent.timestamp.desc())\
               .limit(limit).all()
    db.close()
    return events