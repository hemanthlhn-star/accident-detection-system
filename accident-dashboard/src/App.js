import React, { useState, useEffect, useRef, useCallback } from "react";
import axios from "axios";

const API = "http://localhost:8000";
const VIDEO_THRESHOLD = 0.55;
const LIVE_THRESHOLD  = 0.55;

function toIST(utcStr) {
  return new Date(utcStr).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", hour12: true
  });
}

let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx || audioCtx.state === "closed")
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playAlarm(severity) {
  try {
    const ctx = getAudioCtx();
    ctx.resume().then(() => {
      const times = severity === "critical"
        ? [0, 0.22, 0.44, 0.66, 0.88, 1.1]
        : [0, 0.45];
      times.forEach(t => {
        const osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = severity === "critical" ? 1100 : 880;
        osc.type = "square";
        gain.gain.setValueAtTime(0.4, ctx.currentTime + t);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.2);
        osc.start(ctx.currentTime + t);
        osc.stop(ctx.currentTime + t + 0.2);
      });
    });
  } catch(e) { console.warn("Audio:", e); }
}

function SeverityBadge({ confidence, severity }) {
  const crit = severity === "critical";
  return (
    <div style={{
      display:"flex", alignItems:"center", gap:12,
      background: crit ? "#fff1f1" : "#fffbeb",
      border:`2px solid ${crit?"#fca5a5":"#fcd34d"}`,
      borderRadius:10, padding:"10px 16px", marginBottom:10
    }}>
      <span style={{ fontSize:22 }}>{crit?"🚨":"⚠️"}</span>
      <div>
        <div style={{ fontWeight:800, color:crit?"#b91c1c":"#b45309", fontSize:14 }}>
          {crit?"CRITICAL ACCIDENT DETECTED":"ACCIDENT DETECTED"}
        </div>
        <div style={{ fontSize:12, color:"#6b7280", marginTop:1 }}>
          Confidence: <b>{(confidence*100).toFixed(1)}%</b> ·
          Severity: <b>{(severity||"warning").toUpperCase()}</b>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [events, setEvents]           = useState([]);
  const [alertBanner, setAlertBanner] = useState(null);
  const [videoSrc, setVideoSrc]       = useState(null);
  const [detection, setDetection]     = useState(null);
  const [overlayFrame, setOverlay]    = useState(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [liveDetection, setLiveDet]   = useState(null);
  const [status, setStatus]           = useState("Connecting...");
  const [mode, setMode]               = useState("video");
  const [liveOn, setLiveOn]           = useState(false);
  const [alarmOn, setAlarmOn]         = useState(true);
  const [menuOpen, setMenuOpen]       = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const alarmRef        = useRef(true);
  const wsRef           = useRef(null);
  const videoRef        = useRef(null);
  const canvasRef       = useRef(null);
  const vidIntervalRef  = useRef(null);
  const liveIntervalRef = useRef(null);
  const lastAlertTs     = useRef(0);
  const detectingRef    = useRef(false);

  useEffect(() => { alarmRef.current = alarmOn; }, [alarmOn]);

  useEffect(() => {
    const unlock = () => { try { getAudioCtx().resume(); } catch(e) {} };
    document.addEventListener("click",      unlock, { once:true });
    document.addEventListener("touchstart", unlock, { once:true });
  }, []);

  useEffect(() => {
    let dead = false;
    const connect = () => {
      if (dead) return;
      const ws = new WebSocket(`ws://localhost:8000/ws/alerts`);
      wsRef.current = ws;
      ws.onopen    = () => setStatus("Live ✓");
      ws.onmessage = (e) => {
        const d = JSON.parse(e.data);
        if (d.type === "ACCIDENT_ALERT") {
          setAlertBanner({ conf:d.confidence, sev:d.severity });
          if (alarmRef.current) playAlarm(d.severity);
          setTimeout(() => setAlertBanner(null), 8000);
          fetchEvents();
        }
      };
      ws.onclose = () => { setStatus("Reconnecting..."); if (!dead) setTimeout(connect, 3000); };
      ws.onerror = () => ws.close();
    };
    connect(); fetchEvents();
    return () => { dead=true; wsRef.current?.close(); };
  }, []);

  const fetchEvents = async () => {
    try { const r = await axios.get(`${API}/events`); setEvents(r.data); }
    catch(e) { console.error(e); }
  };

  const captureAndDetect = useCallback(async () => {
    if (detectingRef.current) return;
    const video = videoRef.current, canvas = canvasRef.current;
    if (!video||!canvas||video.paused||video.ended) return;
    detectingRef.current = true;
    try {
      const ctx = canvas.getContext("2d");
      canvas.width = video.videoWidth||640; canvas.height = video.videoHeight||360;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(res => canvas.toBlob(res,"image/jpeg",0.82));
      if (!blob) return;
      const fd = new FormData(); fd.append("file", blob, "frame.jpg");
      const res = await axios.post(`${API}/detect`, fd);
      const det = res.data;
      setDetection(det);
      if (det.annotated_frame) setOverlay(`data:image/jpeg;base64,${det.annotated_frame}`);
      if (det.accident_detected && det.confidence >= VIDEO_THRESHOLD) {
        const now = Date.now();
        if (now - lastAlertTs.current > 8000) {
          lastAlertTs.current = now;
          setAlertBanner({ conf:det.confidence, sev:det.severity });
          if (alarmRef.current) playAlarm(det.severity);
          setTimeout(() => setAlertBanner(null), 8000);
          fetchEvents();
        }
      } else { setOverlay(null); }
    } catch(err) { console.error(err); }
    finally { detectingRef.current = false; }
  }, []);

  const startVideoAnalysis = useCallback(() => {
    if (vidIntervalRef.current) return;
    setIsAnalyzing(true); detectingRef.current = false;
    vidIntervalRef.current = setInterval(captureAndDetect, 800);
  }, [captureAndDetect]);

  const stopVideoAnalysis = useCallback(() => {
    clearInterval(vidIntervalRef.current);
    vidIntervalRef.current = null; detectingRef.current = false;
    setIsAnalyzing(false); setOverlay(null); setDetection(null);
  }, []);

  const startLivePolling = useCallback(() => {
    if (liveIntervalRef.current) return;
    liveIntervalRef.current = setInterval(async () => {
      try {
        const res = await axios.get(`${API}/live-status`);
        const d = res.data; setLiveDet(d);
        if (d.accident_detected && d.confidence >= LIVE_THRESHOLD) {
          const now = Date.now();
          if (now - lastAlertTs.current > 8000) {
            lastAlertTs.current = now;
            setAlertBanner({ conf:d.confidence, sev:d.severity });
            if (alarmRef.current) playAlarm(d.severity);
            setTimeout(() => setAlertBanner(null), 8000);
          }
        }
      } catch(e) { console.error(e); }
    }, 1000);
  }, []);

  const stopLivePolling = useCallback(() => {
    clearInterval(liveIntervalRef.current);
    liveIntervalRef.current = null; setLiveDet(null);
  }, []);

  useEffect(() => {
    if (liveOn) startLivePolling(); else stopLivePolling();
    return () => stopLivePolling();
  }, [liveOn, startLivePolling, stopLivePolling]);

  const handleVideoSelect = (e) => {
    const file = e.target.files[0]; if (!file) return;
    e.target.value = ""; stopVideoAnalysis();
    setAlertBanner(null); setDetection(null); setOverlay(null);
    setVideoSrc(URL.createObjectURL(file));
  };

  const exportCSV = () => {
    const csv = ["ID,Timestamp (IST),Confidence,Camera,Location",
      ...events.map(e => `${e.id},${toIST(e.timestamp)},${(e.confidence*100).toFixed(1)}%,${e.camera_id},${e.location}`)
    ].join("\n");
    const a = document.createElement("a");
    a.href = "data:text/csv,"+encodeURIComponent(csv);
    a.download = "detections.csv"; a.click();
  };

  const switchMode = (m) => {
    setMode(m); setLiveOn(false);
    stopVideoAnalysis(); stopLivePolling();
    setVideoSrc(null); setAlertBanner(null); setLiveDet(null);
  };

  const accidentNow  = detection?.accident_detected     && detection?.confidence     >= VIDEO_THRESHOLD;
  const liveAccident = liveDetection?.accident_detected && liveDetection?.confidence >= LIVE_THRESHOLD;
  const bannerCrit   = alertBanner?.sev === "critical";

  return (
    <div style={s.root}>
      <div style={s.blob1}/><div style={s.blob2}/>
      <canvas ref={canvasRef} style={{ display:"none" }}/>

      {/* Header */}
      <header style={s.header}>
        <div style={s.headerLeft}>
          <div style={s.logoMark}>🛡️</div>
          <div>
            <div style={s.logoTitle}>AccidentGuard AI</div>
            <div style={s.logoSub}>Real-Time CCTV Surveillance · YOLOv8</div>
          </div>
        </div>
        <div style={s.headerRight}>
          <div style={{ ...s.statusPill,
            background: status==="Live ✓"?"rgba(22,163,74,0.15)":status==="Reconnecting..."?"rgba(217,119,6,0.15)":"rgba(220,38,38,0.15)",
            color: status==="Live ✓"?"#16a34a":status==="Reconnecting..."?"#d97706":"#dc2626",
            border: `1px solid ${status==="Live ✓"?"#bbf7d0":status==="Reconnecting..."?"#fde68a":"#fecaca"}`
          }}>
            <span style={{ ...s.statusDot,
              background: status==="Live ✓"?"#16a34a":status==="Reconnecting..."?"#d97706":"#dc2626"
            }}/>
            {status}
          </div>
          <div style={{ position:"relative" }}>
            <button style={s.dotBtn} onClick={() => setMenuOpen(p=>!p)}>⋮</button>
            {menuOpen && (
              <div style={s.dropdown}>
                <div style={s.dropTitle}>Settings</div>
                <div style={s.dropItem}>
                  <span style={{ fontSize:13 }}>{alarmOn?"🔔":"🔕"} Alarm Sound</span>
                  <div style={{ ...s.toggle, background:alarmOn?"#2563eb":"#d1d5db" }}
                       onClick={() => setAlarmOn(p=>!p)}>
                    <div style={{ ...s.toggleThumb, transform:alarmOn?"translateX(17px)":"none" }}/>
                  </div>
                </div>
                <div style={s.dropItem}>
                  <span style={{ fontSize:13 }}>🕐 Detection History</span>
                  <button style={s.miniBtn} onClick={() => { setShowHistory(true); setMenuOpen(false); }}>View</button>
                </div>
                <div style={s.dropItem}>
                  <span style={{ fontSize:13 }}>📋 Export CSV</span>
                  <button style={s.miniBtn} onClick={() => { exportCSV(); setMenuOpen(false); }}>Export</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Alert Banner */}
      {alertBanner && (
        <div style={{ ...s.alertBanner,
          background: bannerCrit
            ? "linear-gradient(135deg,#7f1d1d,#dc2626)"
            : "linear-gradient(135deg,#78350f,#f59e0b)" }}>
          <div style={s.alertPulse}/>
          <span style={{ fontSize:28 }}>{bannerCrit?"🚨":"⚠️"}</span>
          <div style={{ flex:1 }}>
            <div style={{ fontWeight:800, fontSize:17, letterSpacing:0.3 }}>
              {alertBanner.sev.toUpperCase()} ACCIDENT DETECTED
            </div>
            <div style={{ fontSize:12, opacity:0.9, marginTop:3 }}>
              Confidence: {(alertBanner.conf*100).toFixed(1)}% ·{" "}
              {new Date().toLocaleTimeString("en-IN",{timeZone:"Asia/Kolkata"})} IST
              {!alarmOn && " · 🔕 Muted"}
            </div>
          </div>
          <button onClick={()=>setAlertBanner(null)} style={s.dismissBtn}>✕</button>
        </div>
      )}

      {/* Stats Row */}
      <div style={s.statsRow}>
        {[
          { icon:"📹", label:"Total",    value:events.length, color:"#1e3a5f" },
          { icon:"🚨", label:"Critical", value:events.filter(e=>e.confidence>=0.90).length, color:"#dc2626" },
          { icon:"⚠️", label:"Warnings", value:events.filter(e=>e.confidence>=0.55&&e.confidence<0.90).length, color:"#d97706" },
          { icon:alarmOn?"🔔":"🔕", label:"Alarm", value:alarmOn?"ON":"OFF", color:alarmOn?"#16a34a":"#6b7280" },
        ].map(st => (
          <div key={st.label} style={s.statCard}>
            <div style={{ fontSize:22 }}>{st.icon}</div>
            <div style={{ fontSize:28, fontWeight:800, color:st.color, lineHeight:1 }}>{st.value}</div>
            <div style={{ fontSize:10, color:"#9ca3af", textTransform:"uppercase", letterSpacing:1, marginTop:2 }}>{st.label}</div>
          </div>
        ))}
      </div>

      {/* Main Card */}
      <div style={s.card}>
        {/* Tabs */}
        <div style={s.tabRow}>
          {[{key:"video",icon:"🎬",label:"Video Detection"},{key:"live",icon:"📡",label:"Live Stream"}].map(tab=>(
            <button key={tab.key} onClick={()=>switchMode(tab.key)}
                    style={{ ...s.tab, ...(mode===tab.key?s.tabActive:{}) }}>
              {tab.icon} {tab.label}
              {mode===tab.key && <div style={s.tabLine}/>}
            </button>
          ))}
        </div>

        {/* ── Video Mode ── */}
        {mode==="video" && (
          <div>
            <div style={s.uploadZone}>
              <input id="vid" type="file" accept="video/*"
                     onChange={handleVideoSelect} style={{ display:"none" }}/>
              <label htmlFor="vid" style={s.uploadLabel}>
                <div style={{ fontSize:40 }}>🎬</div>
                <div style={{ fontWeight:700, color:"#1e3a5f", fontSize:15, marginTop:8 }}>
                  {videoSrc?"Click to change video":"Upload video for detection"}
                </div>
                <div style={{ color:"#9ca3af", fontSize:12, marginTop:3 }}>MP4 · AVI · MOV</div>
                <div style={s.uploadBtn}>{videoSrc?"📂 Change":"📂 Browse"}</div>
              </label>
            </div>

            {videoSrc && (
              <div style={{ marginTop:16 }}>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
                  <div style={s.sectionLabel}>🎯 Live AI Detection</div>
                  {isAnalyzing && <div style={s.scanPill}><div style={s.spinner}/>Scanning...</div>}
                </div>
                {accidentNow
                  ? <SeverityBadge confidence={detection.confidence} severity={detection.severity}/>
                  : isAnalyzing && detection && <div style={s.okBadge}>✅ No accident in current frame</div>
                }
                <div style={{ position:"relative", lineHeight:0 }}>
                  <video ref={videoRef} src={videoSrc} controls autoPlay
                    style={{ ...s.videoPlayer, opacity:overlayFrame?0:1, position:overlayFrame?"absolute":"relative", top:0, left:0 }}
                    onPlay={startVideoAnalysis} onPause={stopVideoAnalysis}
                    onEnded={stopVideoAnalysis}
                    onSeeking={()=>{setOverlay(null);setDetection(null);}}/>
                  {overlayFrame && <img src={overlayFrame} alt="Detection" style={{ ...s.videoPlayer, display:"block" }}/>}
                  {accidentNow && (
                    <div style={{ ...s.chip,
                      background:detection.severity==="critical"?"rgba(127,29,29,0.92)":"rgba(120,53,15,0.92)" }}>
                      {detection.severity==="critical"?"🚨 CRITICAL":"⚠️ ACCIDENT"} · {(detection.confidence*100).toFixed(0)}%
                    </div>
                  )}
                </div>
                <div style={s.hint}>▶ Press play — AI scans every 800ms automatically</div>
              </div>
            )}
          </div>
        )}

        {/* ── Live Stream Mode ── */}
        {mode==="live" && (
          <div>
            <div style={s.liveInfoBox}>
              <span>📡</span>
              <span>Webcam streams through YOLOv8 in real-time. Requires 2 consecutive detections at 55%+ confidence.</span>
            </div>

            <button onClick={()=>setLiveOn(p=>!p)} style={{ ...s.liveToggleBtn,
              background: liveOn
                ? "linear-gradient(135deg,#7f1d1d,#dc2626)"
                : "linear-gradient(135deg,#14532d,#16a34a)" }}>
              {liveOn?"⏹ Stop Stream":"▶ Start Live Stream"}
            </button>

            {liveOn && (
              <div style={{ marginTop:16 }}>
                {liveAccident
                  ? <SeverityBadge confidence={liveDetection.confidence} severity={liveDetection.severity}/>
                  : liveDetection && <div style={s.okBadge}>✅ No accident detected</div>
                }

                <div style={s.sectionLabel}>📹 Live Camera Feed</div>

                {/* ── Smaller, centered live feed ── */}
                <div style={s.liveContainer}>
                  <div style={{ position:"relative", display:"inline-block", width:"100%" }}>
                    <img
                      key={`live-${liveOn}`}
                      src={`${API}/live-stream`}
                      alt="Live stream"
                      style={s.liveVideo}
                      onError={(e)=>{
                        setTimeout(()=>{ e.target.src=`${API}/live-stream?r=${Date.now()}`; }, 2000);
                      }}
                    />
                    {/* Detection chip on feed */}
                    {liveAccident && (
                      <div style={{ ...s.chip,
                        background: liveDetection.severity==="critical"
                          ? "rgba(127,29,29,0.92)"
                          : "rgba(120,53,15,0.92)" }}>
                        {liveDetection.severity==="critical"?"🚨 CRITICAL":"⚠️ ACCIDENT"} · {(liveDetection.confidence*100).toFixed(0)}%
                      </div>
                    )}
                    {/* Red border when accident */}
                    {liveAccident && (
                      <div style={{
                        position:"absolute", inset:0,
                        border:`3px solid ${liveDetection.severity==="critical"?"#dc2626":"#f59e0b"}`,
                        borderRadius:10, pointerEvents:"none",
                        boxShadow:`0 0 20px ${liveDetection.severity==="critical"?"rgba(220,38,38,0.5)":"rgba(245,158,11,0.5)"}`
                      }}/>
                    )}
                  </div>
                  {/* Live stats below feed */}
                  <div style={s.liveStats}>
                    <div style={s.liveStat}>
                      <span style={{ color:"#9ca3af", fontSize:11 }}>STATUS</span>
                      <span style={{ fontWeight:700, color: liveAccident?"#dc2626":"#16a34a", fontSize:12 }}>
                        {liveAccident?"🔴 ACCIDENT":"🟢 CLEAR"}
                      </span>
                    </div>
                    {liveDetection && (
                      <div style={s.liveStat}>
                        <span style={{ color:"#9ca3af", fontSize:11 }}>CONFIDENCE</span>
                        <span style={{ fontWeight:700, color:"#1e3a5f", fontSize:12 }}>
                          {(liveDetection.confidence*100).toFixed(1)}%
                        </span>
                      </div>
                    )}
                    {liveDetection && (
                      <div style={s.liveStat}>
                        <span style={{ color:"#9ca3af", fontSize:11 }}>CONSECUTIVE</span>
                        <span style={{ fontWeight:700, color:"#1e3a5f", fontSize:12 }}>
                          {liveDetection.consecutive||0} frames
                        </span>
                      </div>
                    )}
                    <div style={s.liveStat}>
                      <span style={{ color:"#9ca3af", fontSize:11 }}>CAMERA</span>
                      <span style={{ fontWeight:700, color:"#1e3a5f", fontSize:12 }}>CAM_01</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* History Modal */}
      {showHistory && (
        <div style={s.overlay} onClick={()=>setShowHistory(false)}>
          <div style={s.modal} onClick={e=>e.stopPropagation()}>
            <div style={s.modalHeader}>
              <div style={{ fontWeight:700, fontSize:15, color:"#1e3a5f", display:"flex", alignItems:"center", gap:8 }}>
                🕐 Detection History <span style={s.countBadge}>{events.length}</span>
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <button onClick={fetchEvents} style={s.smBtn}>↻ Refresh</button>
                <button onClick={exportCSV}   style={s.smBtn}>📋 Export</button>
                <button onClick={()=>setShowHistory(false)} style={s.closeBtn}>✕</button>
              </div>
            </div>
            <div style={{ overflowY:"auto", maxHeight:"65vh" }}>
              {events.length===0 ? (
                <div style={{ textAlign:"center", padding:"48px 0", color:"#9ca3af" }}>
                  <div style={{ fontSize:36 }}>🔍</div>
                  <div style={{ marginTop:8, fontSize:14 }}>No accidents logged yet</div>
                </div>
              ) : (
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                  <thead>
                    <tr>{["ID","Timestamp (IST)","Confidence","Severity","Camera","Location"].map(h=>(
                      <th key={h} style={s.th}>{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {events.map((ev,i)=>(
                      <tr key={ev.id} style={{ background:i%2===0?"#f8faff":"#fff" }}>
                        <td style={s.td}>{ev.id}</td>
                        <td style={s.td}>{toIST(ev.timestamp)}</td>
                        <td style={s.td}>
                          <div style={s.confBar}>
                            <div style={{ ...s.confFill, width:`${ev.confidence*100}%`,
                              background:ev.confidence>=0.90?"#dc2626":"#f97316" }}/>
                            <span style={s.confText}>{(ev.confidence*100).toFixed(1)}%</span>
                          </div>
                        </td>
                        <td style={s.td}>
                          <span style={{ ...s.sevBadge,
                            background:ev.confidence>=0.90?"#fee2e2":"#fff7ed",
                            color:ev.confidence>=0.90?"#991b1b":"#b45309" }}>
                            {ev.confidence>=0.90?"🚨 Critical":"⚠️ Warning"}
                          </span>
                        </td>
                        <td style={s.td}>{ev.camera_id}</td>
                        <td style={s.td}>{ev.location}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin  { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes blob  {
          0%,100%{transform:scale(1) translate(0,0)}
          33%{transform:scale(1.08) translate(28px,-18px)}
          66%{transform:scale(0.94) translate(-18px,28px)}
        }
      `}</style>
    </div>
  );
}

const s = {
  root:         { minHeight:"100vh", background:"linear-gradient(155deg,#f0f4ff 0%,#eaedff 50%,#f5f0ff 100%)", fontFamily:"'Segoe UI',system-ui,sans-serif", paddingBottom:48, position:"relative", overflow:"hidden" },
  blob1:        { position:"fixed", top:-160, left:-160, width:480, height:480, borderRadius:"50%", background:"radial-gradient(circle,rgba(37,99,235,0.1),transparent 70%)", animation:"blob 9s ease-in-out infinite", pointerEvents:"none" },
  blob2:        { position:"fixed", bottom:-140, right:-140, width:560, height:560, borderRadius:"50%", background:"radial-gradient(circle,rgba(220,38,38,0.07),transparent 70%)", animation:"blob 11s ease-in-out infinite reverse", pointerEvents:"none" },
  header:       { background:"linear-gradient(135deg,#080e1a 0%,#0f2340 50%,#1a3a6b 100%)", padding:"16px 28px", display:"flex", justifyContent:"space-between", alignItems:"center", boxShadow:"0 2px 24px rgba(0,0,0,0.4)" },
  headerLeft:   { display:"flex", alignItems:"center", gap:14 },
  logoMark:     { fontSize:30, filter:"drop-shadow(0 0 12px rgba(96,165,250,0.9))" },
  logoTitle:    { color:"#fff", fontWeight:800, fontSize:20, letterSpacing:0.5 },
  logoSub:      { color:"#60a5fa", fontSize:10, marginTop:3, letterSpacing:0.5 },
  headerRight:  { display:"flex", alignItems:"center", gap:10 },
  statusPill:   { display:"flex", alignItems:"center", gap:6, padding:"6px 14px", borderRadius:20, fontSize:12, fontWeight:700 },
  statusDot:    { width:7, height:7, borderRadius:"50%", display:"inline-block" },
  dotBtn:       { background:"rgba(255,255,255,0.1)", border:"1px solid rgba(255,255,255,0.2)", color:"#fff", borderRadius:8, width:36, height:36, fontSize:22, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" },
  dropdown:     { position:"absolute", top:44, right:0, background:"#fff", borderRadius:12, boxShadow:"0 8px 32px rgba(0,0,0,0.15)", minWidth:220, zIndex:9999, border:"1px solid #e5e7eb", overflow:"hidden" },
  dropTitle:    { padding:"9px 14px", fontSize:10, fontWeight:800, color:"#9ca3af", letterSpacing:1.5, textTransform:"uppercase", borderBottom:"1px solid #f3f4f6" },
  dropItem:     { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"11px 14px", borderBottom:"1px solid #f9fafb", color:"#374151" },
  toggle:       { width:36, height:20, borderRadius:10, cursor:"pointer", position:"relative", transition:"background 0.2s", flexShrink:0 },
  toggleThumb:  { position:"absolute", top:2.5, left:3, width:15, height:15, borderRadius:"50%", background:"#fff", transition:"transform 0.2s", boxShadow:"0 1px 3px rgba(0,0,0,0.2)" },
  miniBtn:      { background:"#eff6ff", color:"#1d4ed8", border:"none", borderRadius:6, padding:"4px 12px", fontSize:11, cursor:"pointer", fontWeight:700 },
  alertBanner:  { margin:"12px 24px", borderRadius:12, padding:"14px 20px", display:"flex", alignItems:"center", gap:12, color:"#fff", boxShadow:"0 4px 20px rgba(220,38,38,0.3)", position:"relative", overflow:"hidden" },
  alertPulse:   { position:"absolute", inset:0, background:"rgba(255,255,255,0.05)", animation:"pulse 1.5s ease-in-out infinite", pointerEvents:"none" },
  dismissBtn:   { background:"rgba(255,255,255,0.2)", border:"none", color:"#fff", borderRadius:8, padding:"4px 10px", cursor:"pointer", fontSize:14, fontWeight:700 },
  statsRow:     { display:"flex", gap:12, padding:"14px 24px 0", flexWrap:"wrap" },
  statCard:     { flex:1, minWidth:100, background:"#fff", borderRadius:12, padding:"14px", textAlign:"center", boxShadow:"0 1px 8px rgba(0,0,0,0.06)", border:"1px solid #e9ecf7", display:"flex", flexDirection:"column", alignItems:"center", gap:3 },
  card:         { background:"#fff", borderRadius:16, margin:"14px 24px", padding:22, boxShadow:"0 2px 16px rgba(0,0,0,0.06)", border:"1px solid #e9ecf7" },
  tabRow:       { display:"flex", gap:2, marginBottom:20, borderBottom:"2px solid #f0f4ff" },
  tab:          { background:"none", border:"none", padding:"9px 20px", fontSize:13, fontWeight:700, color:"#9ca3af", cursor:"pointer", position:"relative" },
  tabActive:    { color:"#2563eb" },
  tabLine:      { position:"absolute", bottom:-2, left:0, right:0, height:2.5, background:"linear-gradient(90deg,#2563eb,#60a5fa)", borderRadius:2 },
  uploadZone:   { background:"linear-gradient(135deg,#f0f7ff,#f8faff)", borderRadius:12, border:"2px dashed #93c5fd" },
  uploadLabel:  { display:"flex", flexDirection:"column", alignItems:"center", cursor:"pointer", padding:"24px 20px" },
  uploadBtn:    { background:"linear-gradient(135deg,#1e3a5f,#2563eb)", color:"#fff", padding:"8px 20px", borderRadius:8, fontSize:12, fontWeight:700, marginTop:12 },
  sectionLabel: { fontSize:11, fontWeight:800, color:"#6b7280", letterSpacing:1, textTransform:"uppercase", marginBottom:8 },
  scanPill:     { display:"flex", alignItems:"center", gap:5, background:"#eff6ff", padding:"4px 12px", borderRadius:20, fontSize:11, color:"#2563eb", fontWeight:700 },
  spinner:      { width:11, height:11, border:"2px solid #bfdbfe", borderTop:"2px solid #2563eb", borderRadius:"50%", animation:"spin 0.7s linear infinite", flexShrink:0 },
  okBadge:      { background:"#f0fdf4", border:"1.5px solid #86efac", borderRadius:8, padding:"8px 14px", fontSize:12, color:"#15803d", fontWeight:700, marginBottom:8 },
  videoPlayer:  { width:"100%", borderRadius:10, border:"2px solid #e5e7eb", display:"block", background:"#000" },
  chip:         { position:"absolute", top:10, left:10, color:"#fff", padding:"6px 14px", borderRadius:6, fontSize:12, fontWeight:800, backdropFilter:"blur(4px)", border:"1px solid rgba(255,255,255,0.2)" },
  hint:         { fontSize:10, color:"#9ca3af", marginTop:6, textAlign:"center" },
  liveInfoBox:  { background:"#eff6ff", borderRadius:8, padding:"10px 14px", fontSize:12, color:"#1d4ed8", marginBottom:14, display:"flex", alignItems:"flex-start", gap:8, lineHeight:1.5 },
  liveToggleBtn:{ color:"#fff", border:"none", padding:"11px 28px", borderRadius:10, fontSize:14, fontWeight:800, cursor:"pointer", boxShadow:"0 3px 12px rgba(0,0,0,0.2)" },
  // ── Smaller live feed ──
  liveContainer:{ background:"#0a0f1e", borderRadius:12, overflow:"hidden", maxWidth:560, margin:"0 auto" },
  liveVideo:    { width:"100%", display:"block", maxHeight:360, objectFit:"cover" },
  liveStats:    { display:"flex", justifyContent:"space-around", padding:"10px 16px", background:"#0f172a", borderTop:"1px solid rgba(255,255,255,0.08)" },
  liveStat:     { display:"flex", flexDirection:"column", alignItems:"center", gap:2 },
  overlay:      { position:"fixed", inset:0, background:"rgba(0,0,0,0.6)", zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center", padding:20 },
  modal:        { background:"#fff", borderRadius:16, width:"100%", maxWidth:900, maxHeight:"85vh", boxShadow:"0 20px 60px rgba(0,0,0,0.3)", overflow:"hidden", display:"flex", flexDirection:"column" },
  modalHeader:  { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"18px 22px", borderBottom:"1px solid #f0f4ff", flexShrink:0 },
  countBadge:   { background:"#eff6ff", color:"#1d4ed8", borderRadius:20, padding:"2px 10px", fontSize:11, fontWeight:800 },
  smBtn:        { background:"linear-gradient(135deg,#1e3a5f,#2563eb)", color:"#fff", border:"none", padding:"6px 12px", borderRadius:7, cursor:"pointer", fontSize:11, fontWeight:700 },
  closeBtn:     { background:"#f3f4f6", color:"#374151", border:"none", padding:"6px 11px", borderRadius:7, cursor:"pointer", fontSize:14, fontWeight:800 },
  th:           { textAlign:"left", padding:"10px 16px", background:"#f0f7ff", color:"#1e3a5f", fontWeight:800, fontSize:10, textTransform:"uppercase", letterSpacing:0.3 },
  td:           { padding:"10px 16px", borderBottom:"1px solid #f3f6ff", fontSize:12 },
  confBar:      { position:"relative", background:"#f3f4f6", borderRadius:20, height:20, minWidth:100, overflow:"hidden", display:"flex", alignItems:"center" },
  confFill:     { position:"absolute", left:0, top:0, bottom:0, borderRadius:20, opacity:0.3 },
  confText:     { position:"relative", zIndex:1, fontWeight:800, fontSize:11, paddingLeft:8 },
  sevBadge:     { padding:"3px 10px", borderRadius:20, fontSize:10, fontWeight:800 },
};