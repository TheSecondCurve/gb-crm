/** PR 8 占位页：标题 + 建设中。PR 10/11 填 DataGrid。 */
export function PlaceholderPage({ title }: { title: string }) {
  return (
    <>
      <div className="page-head">
        <h1>{title}</h1>
      </div>
      <div className="card">
        <div className="empty">建设中</div>
      </div>
    </>
  );
}
