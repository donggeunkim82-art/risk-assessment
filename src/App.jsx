import { useState, useRef, useCallback, useEffect } from "react";

const SYSTEM_PROMPT = `당신은 산업안전보건 전문가입니다. 사용자가 업로드한 현장 사진을 분석하여 위험성평가표를 작성해야 합니다.

반드시 아래 JSON 형식으로만 응답하세요. 다른 텍스트나 마크다운 없이 순수 JSON만 반환하세요.

{
  "작업명": "현장에서 수행 중인 작업명",
  "작업장소": "작업 장소 설명",
  "평가일자": "오늘 날짜",
  "위험요인목록": [
    {
      "번호": 1,
      "공정단계": "해당 공정/단계",
      "유해위험요인": "구체적 위험요인",
      "위험원인": "위험이 발생하는 원인",
      "예상재해": "발생 가능한 재해 유형",
      "빈도": 3,
      "강도": 4,
      "위험성": 12,
      "위험등급": "상",
      "감소대책": "위험 감소를 위한 구체적 대책",
      "개선후빈도": 2,
      "개선후강도": 3,
      "개선후위험성": 6,
      "개선후위험등급": "중"
    }
  ],
  "종합의견": "전반적인 안전 상태 및 권고사항"
}

규칙:
- 빈도와 강도는 각각 1~5 사이 숫자
- 위험성 = 빈도 × 강도
- 위험등급: 위험성 15이상=최상, 9~14=상, 4~8=중, 1~3=하
- 최소 4개 이상의 위험요인을 찾아내세요
- 사진에서 실제로 보이는 위험요인을 구체적으로 기술하세요`;

const RISK_COLORS = {
  최상: { bg: "#ff4444", text: "#fff" },
  상:   { bg: "#ff8c00", text: "#fff" },
  중:   { bg: "#ffd700", text: "#333" },
  하:   { bg: "#4caf50", text: "#fff" },
};

export default function RiskAssessmentApp() {
  const [image, setImage] = useState(null);
  const [imageBase64, setImageBase64] = useState(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);

  // Camera states
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState(null);
  const [facingMode, setFacingMode] = useState("environment"); // back camera default
  const [flashOn, setFlashOn] = useState(false);
  const [stream, setStream] = useState(null);

  const fileInputRef = useRef(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  // Start camera
  const startCamera = useCallback(async (facing = facingMode) => {
    setCameraError(null);
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      setStream(s);
      if (videoRef.current) {
        videoRef.current.srcObject = s;
      }
    } catch (err) {
      setCameraError("카메라 접근 권한이 필요합니다. 브라우저 설정에서 카메라를 허용해주세요.");
    }
  }, [facingMode, stream]);

  // Attach stream to video when camera opens
  useEffect(() => {
    if (cameraOpen) {
      // small delay so videoRef is mounted
      setTimeout(() => startCamera(facingMode), 100);
    } else {
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        setStream(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraOpen]);

  // Flip camera
  const flipCamera = async () => {
    const next = facingMode === "environment" ? "user" : "environment";
    setFacingMode(next);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: next, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      setStream(s);
      if (videoRef.current) videoRef.current.srcObject = s;
    } catch (err) {
      setCameraError("카메라 전환에 실패했습니다.");
    }
  };

  // Capture photo
  const capturePhoto = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");

    if (flashOn) {
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      setTimeout(() => {
        ctx.drawImage(video, 0, 0);
        finishCapture(canvas);
      }, 80);
    } else {
      ctx.drawImage(video, 0, 0);
      finishCapture(canvas);
    }
  };

  const finishCapture = (canvas) => {
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    setImage(dataUrl);
    setImageBase64(dataUrl.split(",")[1]);
    setResult(null);
    setError(null);
    setCameraOpen(false);
  };

  // File upload
  const processFile = useCallback((file) => {
    if (!file || !file.type.startsWith("image/")) {
      setError("이미지 파일만 업로드 가능합니다.");
      return;
    }
    const url = URL.createObjectURL(file);
    setImage(url);
    setResult(null);
    setError(null);
    const reader = new FileReader();
    reader.onload = (e) => setImageBase64(e.target.result.split(",")[1]);
    reader.readAsDataURL(file);
  }, []);

  const handleFileChange = (e) => { if (e.target.files[0]) processFile(e.target.files[0]); };
  const handleDrop = (e) => {
    e.preventDefault(); setDragOver(false);
    if (e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0]);
  };

  // Analyze
  const analyze = async () => {
    if (!imageBase64) return;
    setLoading(true); setError(null); setResult(null);
    try {
      const today = new Date().toLocaleDateString("ko-KR");
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 2000,
          system: SYSTEM_PROMPT,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } },
              { type: "text", text: `이 현장 사진을 분석하여 위험성평가표를 작성해주세요. 오늘 날짜는 ${today}입니다. 반드시 JSON만 반환하세요.` },
            ],
          }],
        }),
      });
      const data = await res.json();
      const text = data.content?.map((c) => c.text || "").join("") || "";
      setResult(JSON.parse(text.replace(/```json|```/g, "").trim()));
    } catch (err) {
      setError("분석 중 오류가 발생했습니다. 다시 시도해주세요.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={S.app}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;900&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0f1117; }
        @media print {
          .no-print { display: none !important; }
          body { background: white; }
        }
        .upload-zone:hover { border-color: #00d4aa !important; background: rgba(0,212,170,0.05) !important; }
        .analyze-btn:hover:not(:disabled) { background: #00b894 !important; transform: translateY(-1px); }
        .analyze-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        tr:hover td { background: rgba(0,212,170,0.04); }
        .icon-btn:hover { background: rgba(255,255,255,0.15) !important; }
        .shutter:hover { transform: scale(1.08); }
        .shutter:active { transform: scale(0.95); }
      `}</style>

      {/* ── CAMERA OVERLAY ── */}
      {cameraOpen && (
        <div style={S.cameraOverlay}>
          <div style={S.cameraInner}>
            {/* Top bar */}
            <div style={S.camTopBar}>
              <button className="icon-btn" style={S.iconBtn} onClick={() => setCameraOpen(false)}>✕</button>
              <span style={S.camTitle}>현장 촬영</span>
              <button
                className="icon-btn"
                style={{ ...S.iconBtn, color: flashOn ? "#ffd700" : "#fff" }}
                onClick={() => setFlashOn((f) => !f)}
                title="플래시"
              >⚡</button>
            </div>

            {/* Viewfinder */}
            <div style={S.viewfinder}>
              {cameraError ? (
                <div style={S.camErr}>
                  <div style={{ fontSize: 40, marginBottom: 12 }}>📷</div>
                  <div style={{ color: "#ff6b6b", fontSize: 14, textAlign: "center", lineHeight: 1.6 }}>{cameraError}</div>
                </div>
              ) : (
                <video ref={videoRef} autoPlay playsInline muted style={S.video} />
              )}
              {/* Corner guides */}
              {["tl","tr","bl","br"].map(c => <div key={c} style={{ ...S.corner, ...S.corners[c] }} />)}
            </div>

            {/* Bottom controls */}
            <div style={S.camBotBar}>
              {/* Gallery */}
              <button className="icon-btn" style={S.iconBtn} onClick={() => { setCameraOpen(false); fileInputRef.current?.click(); }}>
                🖼
              </button>
              {/* Shutter */}
              <button className="shutter" style={S.shutter} onClick={capturePhoto} disabled={!!cameraError}>
                <div style={S.shutterInner} />
              </button>
              {/* Flip */}
              <button className="icon-btn" style={S.iconBtn} onClick={flipCamera}>🔄</button>
            </div>
          </div>
          <canvas ref={canvasRef} style={{ display: "none" }} />
        </div>
      )}

      {/* ── HEADER ── */}
      <div style={S.header} className="no-print">
        <div style={S.headerInner}>
          <div style={S.logo}>
            <div style={S.logoIcon}>⚠</div>
            <div>
              <div style={S.logoTitle}>위험성평가 AI</div>
              <div style={S.logoSub}>사진 한 장으로 자동 생성</div>
            </div>
          </div>
          <div style={S.badge}>산업안전보건법 기반</div>
        </div>
      </div>

      <div style={S.container}>
        {/* ── INPUT SECTION ── */}
        <div className="no-print" style={{ marginBottom: 32 }}>

          {/* Action buttons */}
          <div style={S.actionRow}>
            <button style={S.camBtn} onClick={() => setCameraOpen(true)}>
              <span style={{ fontSize: 20 }}>📷</span>
              <span>카메라 촬영</span>
            </button>
            <button style={S.fileBtn} onClick={() => fileInputRef.current?.click()}>
              <span style={{ fontSize: 20 }}>📁</span>
              <span>파일 업로드</span>
            </button>
          </div>

          {/* Drop zone / preview */}
          <div
            className="upload-zone"
            style={{
              ...S.uploadZone,
              borderColor: dragOver ? "#00d4aa" : image ? "#00d4aa" : "#2a2d3e",
              background: dragOver ? "rgba(0,212,170,0.05)" : image ? "rgba(0,212,170,0.03)" : "#13161f",
              cursor: image ? "default" : "pointer",
            }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => !image && fileInputRef.current?.click()}
          >
            {image ? (
              <div style={S.previewWrap}>
                <img src={image} alt="현장 사진" style={S.preview} />
                <div style={S.previewBtns}>
                  <button style={S.previewBtn} onClick={(e) => { e.stopPropagation(); setCameraOpen(true); }}>📷 재촬영</button>
                  <button style={S.previewBtn} onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}>📁 파일 변경</button>
                </div>
              </div>
            ) : (
              <div style={S.placeholder}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>🏗</div>
                <div style={{ fontSize: 15, color: "#9ca3af", marginBottom: 6 }}>위 버튼으로 촬영하거나 파일을 드래그하세요</div>
                <div style={{ fontSize: 13, color: "#4b5563" }}>JPG · PNG · WEBP</div>
              </div>
            )}
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileChange} style={{ display: "none" }} />

          <button
            className="analyze-btn"
            style={S.analyzeBtn}
            onClick={analyze}
            disabled={!imageBase64 || loading}
          >
            {loading ? "⟳  AI 분석 중..." : "🔍  위험성평가 자동 생성"}
          </button>

          {error && <div style={S.errBox}>{error}</div>}
        </div>

        {/* ── RESULT ── */}
        {result && (
          <div style={S.resultSection}>
            <div style={S.reportHeader}>
              <div style={S.reportTitle}>위험성평가표</div>
              <div style={S.metaGrid}>
                {[["작업명", result.작업명], ["작업장소", result.작업장소], ["평가일자", result.평가일자], ["위험요인 수", `${result.위험요인목록?.length}건`]].map(([l, v]) => (
                  <div key={l} style={S.metaItem}><div style={S.metaLabel}>{l}</div><div style={S.metaVal}>{v}</div></div>
                ))}
              </div>
            </div>

            <div style={S.summaryRow}>
              {["최상","상","중","하"].map((g) => {
                const cnt = result.위험요인목록?.filter(r => r.위험등급 === g).length || 0;
                return (
                  <div key={g} style={{ ...S.summaryCard, background: RISK_COLORS[g].bg }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: RISK_COLORS[g].text, opacity: 0.85 }}>{g}</div>
                    <div style={{ fontSize: 28, fontWeight: 900, color: RISK_COLORS[g].text }}>{cnt}건</div>
                  </div>
                );
              })}
            </div>

            <div style={{ overflowX: "auto" }}>
              <table style={S.table}>
                <thead>
                  <tr>
                    {["No.","공정단계","유해위험요인","예상재해","빈도","강도","위험성","등급","감소대책","개선후"].map(h => (
                      <th key={h} style={S.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.위험요인목록?.map((item) => (
                    <tr key={item.번호}>
                      <td style={{ ...S.td, textAlign: "center", fontWeight: 700 }}>{item.번호}</td>
                      <td style={S.td}>{item.공정단계}</td>
                      <td style={S.td}><div style={{ fontWeight: 500 }}>{item.유해위험요인}</div><div style={S.sub}>{item.위험원인}</div></td>
                      <td style={S.td}>{item.예상재해}</td>
                      <td style={{ ...S.td, textAlign: "center" }}>{item.빈도}</td>
                      <td style={{ ...S.td, textAlign: "center" }}>{item.강도}</td>
                      <td style={{ ...S.td, textAlign: "center", fontWeight: 700 }}>{item.위험성}</td>
                      <td style={{ ...S.td, textAlign: "center" }}><Badge g={item.위험등급} /></td>
                      <td style={S.td}>{item.감소대책}</td>
                      <td style={{ ...S.td, textAlign: "center" }}><Badge g={item.개선후위험등급} /><div style={S.sub}>{item.개선후위험성}</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={S.opinion}>
              <div style={S.opinionLabel}>종합의견 및 권고사항</div>
              <div style={{ fontSize: 14, color: "#9ca3af", lineHeight: 1.7 }}>{result.종합의견}</div>
            </div>

            <div style={S.actions} className="no-print">
              <button style={S.printBtn} onClick={() => window.print()}>🖨 인쇄 / PDF 저장</button>
              <button style={S.resetBtn} onClick={() => { setResult(null); setImage(null); setImageBase64(null); }}>새 평가 시작</button>
            </div>
          </div>
        )}

        {/* ── GUIDE ── */}
        {!result && !loading && (
          <div style={S.guide} className="no-print">
            <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", marginBottom: 20 }}>사용 방법</div>
            {[
              { n: "1", t: "현장 촬영 또는 사진 업로드", d: "카메라로 직접 찍거나 갤러리/파일에서 선택" },
              { n: "2", t: "AI 자동 분석", d: "Claude AI가 위험요인을 식별하고 등급 산정" },
              { n: "3", t: "평가표 확인 및 출력", d: "위험성평가표 즉시 생성 — 인쇄 또는 PDF 저장 가능" },
            ].map((s) => (
              <div key={s.n} style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 16 }}>
                <div style={S.guideNum}>{s.n}</div>
                <div><div style={{ fontWeight: 600, color: "#e8eaf0", marginBottom: 4 }}>{s.t}</div><div style={{ fontSize: 13, color: "#6b7280" }}>{s.d}</div></div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Badge({ g }) {
  const c = RISK_COLORS[g] || RISK_COLORS["하"];
  return <span style={{ background: c.bg, color: c.text, borderRadius: 6, padding: "2px 10px", fontSize: 12, fontWeight: 700 }}>{g}</span>;
}

const S = {
  app: { fontFamily: "'Noto Sans KR', sans-serif", minHeight: "100vh", background: "#0f1117", color: "#e8eaf0" },
  header: { background: "#13161f", borderBottom: "1px solid #1e2130", padding: "16px 0" },
  headerInner: { maxWidth: 1000, margin: "0 auto", padding: "0 20px", display: "flex", alignItems: "center", justifyContent: "space-between" },
  logo: { display: "flex", alignItems: "center", gap: 12 },
  logoIcon: { fontSize: 24, background: "linear-gradient(135deg,#00d4aa,#0099ff)", borderRadius: 10, width: 46, height: 46, display: "flex", alignItems: "center", justifyContent: "center" },
  logoTitle: { fontSize: 18, fontWeight: 700, color: "#fff" },
  logoSub: { fontSize: 12, color: "#6b7280", marginTop: 2 },
  badge: { background: "rgba(0,212,170,0.12)", color: "#00d4aa", border: "1px solid rgba(0,212,170,0.3)", borderRadius: 20, padding: "4px 12px", fontSize: 12, fontWeight: 500 },
  container: { maxWidth: 1000, margin: "0 auto", padding: "32px 20px" },

  actionRow: { display: "flex", gap: 12, marginBottom: 16 },
  camBtn: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "14px", background: "linear-gradient(135deg,#00d4aa,#0099ff)", color: "#0f1117", border: "none", borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: "pointer" },
  fileBtn: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "14px", background: "#1e2130", color: "#e8eaf0", border: "1px solid #2a2d3e", borderRadius: 12, fontSize: 15, fontWeight: 600, cursor: "pointer" },

  uploadZone: { border: "2px dashed", borderRadius: 16, transition: "all 0.2s", minHeight: 200, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 16 },
  previewWrap: { width: "100%", textAlign: "center", padding: 16 },
  preview: { maxHeight: 380, maxWidth: "100%", borderRadius: 12, objectFit: "contain" },
  previewBtns: { display: "flex", justifyContent: "center", gap: 10, marginTop: 12 },
  previewBtn: { background: "rgba(0,0,0,0.6)", color: "#fff", border: "none", borderRadius: 8, padding: "6px 16px", cursor: "pointer", fontSize: 13 },
  placeholder: { textAlign: "center", padding: 40 },
  analyzeBtn: { width: "100%", padding: 16, background: "#00d4aa", color: "#0f1117", border: "none", borderRadius: 12, fontSize: 16, fontWeight: 700, cursor: "pointer", transition: "all 0.2s" },
  errBox: { background: "rgba(255,68,68,0.1)", border: "1px solid rgba(255,68,68,0.3)", borderRadius: 10, padding: "12px 16px", color: "#ff6b6b", marginTop: 12, fontSize: 14 },

  // Camera
  cameraOverlay: { position: "fixed", inset: 0, background: "#000", zIndex: 9999, display: "flex", flexDirection: "column" },
  cameraInner: { flex: 1, display: "flex", flexDirection: "column" },
  camTopBar: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", background: "rgba(0,0,0,0.6)" },
  camTitle: { color: "#fff", fontWeight: 700, fontSize: 16 },
  iconBtn: { background: "rgba(255,255,255,0.1)", border: "none", color: "#fff", borderRadius: 10, width: 40, height: 40, fontSize: 18, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "background 0.15s" },
  viewfinder: { flex: 1, position: "relative", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", background: "#111" },
  video: { width: "100%", height: "100%", objectFit: "cover" },
  camErr: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 40 },
  corner: { position: "absolute", width: 28, height: 28, border: "3px solid #00d4aa", pointerEvents: "none" },
  corners: {
    tl: { top: 20, left: 20, borderRight: "none", borderBottom: "none", borderTopLeftRadius: 6 },
    tr: { top: 20, right: 20, borderLeft: "none", borderBottom: "none", borderTopRightRadius: 6 },
    bl: { bottom: 20, left: 20, borderRight: "none", borderTop: "none", borderBottomLeftRadius: 6 },
    br: { bottom: 20, right: 20, borderLeft: "none", borderTop: "none", borderBottomRightRadius: 6 },
  },
  camBotBar: { display: "flex", alignItems: "center", justifyContent: "space-around", padding: "24px 40px", background: "rgba(0,0,0,0.7)" },
  shutter: { width: 72, height: 72, borderRadius: "50%", border: "4px solid #fff", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "transform 0.15s" },
  shutterInner: { width: 56, height: 56, borderRadius: "50%", background: "#fff" },

  // Result
  resultSection: { background: "#13161f", borderRadius: 20, border: "1px solid #1e2130", overflow: "hidden" },
  reportHeader: { background: "linear-gradient(135deg,rgba(0,212,170,0.08),rgba(0,153,255,0.06))", borderBottom: "1px solid #1e2130", padding: "28px 32px" },
  reportTitle: { fontSize: 24, fontWeight: 900, color: "#fff", marginBottom: 20, letterSpacing: -0.5 },
  metaGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(175px,1fr))", gap: 12 },
  metaItem: { background: "rgba(255,255,255,0.04)", borderRadius: 10, padding: "12px 16px" },
  metaLabel: { fontSize: 11, color: "#6b7280", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 },
  metaVal: { fontSize: 15, fontWeight: 600, color: "#e8eaf0" },
  summaryRow: { display: "flex", borderBottom: "1px solid #1e2130" },
  summaryCard: { flex: 1, padding: "20px", textAlign: "center" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { background: "#0f1117", color: "#9ca3af", fontWeight: 600, padding: "12px 10px", textAlign: "left", borderBottom: "1px solid #1e2130", fontSize: 12, whiteSpace: "nowrap" },
  td: { padding: "12px 10px", borderBottom: "1px solid #1a1d2e", color: "#d1d5db", verticalAlign: "top", lineHeight: 1.5 },
  sub: { fontSize: 11, color: "#6b7280", marginTop: 4 },
  opinion: { margin: 24, background: "rgba(0,212,170,0.06)", border: "1px solid rgba(0,212,170,0.2)", borderRadius: 12, padding: "20px 24px" },
  opinionLabel: { fontSize: 13, fontWeight: 700, color: "#00d4aa", marginBottom: 10 },
  actions: { display: "flex", gap: 12, padding: "20px 24px 24px", borderTop: "1px solid #1e2130" },
  printBtn: { flex: 1, padding: 12, background: "#1e2130", color: "#e8eaf0", border: "1px solid #2a2d3e", borderRadius: 10, cursor: "pointer", fontSize: 14, fontWeight: 600 },
  resetBtn: { flex: 1, padding: 12, background: "transparent", color: "#6b7280", border: "1px solid #2a2d3e", borderRadius: 10, cursor: "pointer", fontSize: 14 },
  guide: { background: "#13161f", borderRadius: 16, border: "1px solid #1e2130", padding: "28px 32px" },
  guideNum: { width: 36, height: 36, background: "linear-gradient(135deg,#00d4aa,#0099ff)", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, color: "#0f1117", flexShrink: 0, fontSize: 16 },
};