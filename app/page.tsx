export default function HomePage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "system-ui, sans-serif",
        background: "#0f172a",
        color: "#e2e8f0",
        padding: "2rem",
      }}
    >
      <div style={{ maxWidth: 480, textAlign: "center" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.75rem" }}>
          OnTap Cron Jobs
        </h1>
        <p style={{ color: "#94a3b8", lineHeight: 1.6, marginBottom: "1rem" }}>
          Scheduled worker service. HTTP cron endpoints live under{" "}
          <code style={{ color: "#38bdf8" }}>/api/cron/*</code> and require a valid{" "}
          <code style={{ color: "#38bdf8" }}>CRON_SECRET</code>.
        </p>
        <p style={{ color: "#64748b", fontSize: "0.875rem" }}>
          No public database or admin APIs are exposed from this application.
        </p>
      </div>
    </main>
  );
}
