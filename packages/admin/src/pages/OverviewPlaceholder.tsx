import '../styles/admin.css';

/** 总览占位页（骨架）：教师总览/健康/交互看板由 A3/A4 切片补充。 */
export function OverviewPlaceholder() {
  return (
    <section className="page-card empty-state" aria-label="总览占位">
      <h3>总览占位</h3>
      <p>教师总览、系统健康与交互看板将在后续切片中补充。</p>
    </section>
  );
}
