import "./PluginsEmptyView.css";

export function PluginsEmptyView() {
  return (
    <section className="plugins-empty-view">
      <div className="plugins-empty-view__inner">
        <img
          className="plugins-empty-view__logo"
          src="/logo.png"
          alt="SunPilot logo"
        />
        <p className="plugins-empty-view__kicker">插件</p>
        <h1>插件空间暂时为空</h1>
        <p>
          这里会承载可用插件、技能入口和工具能力。当前先保留清爽空状态，让对话区和插件区在同一个工作台内切换。
        </p>
      </div>
    </section>
  );
}
