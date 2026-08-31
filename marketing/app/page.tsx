const controlDimensions = [
  {
    label: "Models",
    title: "Choose the worker for the work.",
    body: "Set models and settings by role or task class. Use a value model for routine work, a premium model when failure is expensive, and change the policy when the economics move.",
  },
  {
    label: "Infrastructure",
    title: "Run in your boundary.",
    body: "Put the control plane and computers in your AWS account, or attach local workers when the job needs your network, repositories, or hardware.",
  },
  {
    label: "Access",
    title: "Wire private systems privately.",
    body: "Connect internal APIs, MCP tools, browsers, and local resources inside boundaries you define. A public SaaS connector is an option, not the architecture.",
  },
  {
    label: "Organization",
    title: "Design the reporting lines.",
    body: "Give named teammates durable roles. Decide who delegates, who reviews, what evidence travels with the work, and exactly where a person must approve.",
  },
];

const comparison = [
  ["Where it runs", "A laptop, homelab, or VPS you supply and operate", "A vendor-operated persistent cloud computer", "Your AWS account or your local hardware"],
  ["Model control", "Broad provider support; you configure the models", "Grok-managed; no per-bot model choice is documented", "Choose model and settings by bot, role, or task class"],
  ["Cost control", "Direct model and hosting bills; optimization is up to you", "Plan allowance plus on-demand model and token usage", "Route by value, set budgets, and escalate only when evidence demands it"],
  ["Private systems", "Whatever the host can safely reach", "Connectors and browser access from the vendor cloud", "Private APIs, MCP, browser, and local tools inside your boundary"],
  ["Operational burden", "You install, secure, patch, and keep the host available", "The service provides and operates the computer", "Infrastructure as code in your account; computers are summoned when needed"],
  ["Agent organization", "Powerful building blocks that you assemble", "Named bots collaborate on one shared computer", "Named roles, reporting lines, durable work, review gates, and approvals"],
];

export default function Home() {
  return (
    <main>
      <nav className="nav" aria-label="Main navigation">
        <a className="wordmark" href="#top" aria-label="Chatticus home">chatticus<span>.</span></a>
        <div className="nav-links"><a href="#control">Why Chatticus</a><a href="#compare">Compare</a></div>
      </nav>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">Your agents. Your models. Your cloud.</p>
          <h1>Build the AI organization <em>you control.</em></h1>
          <p className="lede">Chatticus gives you persistent, named AI teammates on computers in your AWS account or on hardware you control. You choose the models, the economics, the systems they can reach, and the decisions that still require a person.</p>
          <a className="button" href="#compare">Compare the approaches <span aria-hidden="true">↓</span></a>
          <p className="hero-note">The ease of a hosted bot team. The control of your own system.</p>
        </div>

        <div className="org-panel" aria-label="Example Chatticus agent organization">
          <div className="org-header"><div><span className="panel-kicker">Control room</span><strong>Your AI organization</strong></div><span className="budget">$18 / $50 budget</span></div>
          <div className="human-row"><span className="human-mark">You</span><div><strong>Set direction</strong><small>Approve outcomes and consequential actions</small></div></div>
          <div className="connector-line"><span /></div>
          <div className="director-row"><span className="agent-mark">D</span><div><strong>Software Director</strong><small>Assigns, reviews, rejects, and reports</small></div><span className="model premium">premium model</span></div>
          <div className="team-grid">
            <div className="team-card"><span className="agent-mark small">R</span><strong>Researcher</strong><small>Finds and verifies</small><span className="model value">value model</span></div>
            <div className="team-card"><span className="agent-mark small">B</span><strong>Builder</strong><small>Implements and tests</small><span className="model chosen">your choice</span></div>
          </div>
          <div className="approval-row"><span>Approval gate</span><strong>Publishing waits for you</strong><span className="pending">pending</span></div>
        </div>
      </section>

      <section className="thesis" aria-labelledby="thesis-title">
        <p className="eyebrow">From pair programmer to executive</p>
        <h2 id="thesis-title">The next step is not a smarter assistant. It is a better-designed organization.</h2>
        <p>Cheap, capable models make teams of agents practical. The scarce resource is human attention: deciding what matters, defining what good looks like, and examining the outcomes that carry consequences.</p>
      </section>

      <section className="control" id="control" aria-labelledby="control-title">
        <div className="section-heading"><p className="eyebrow">Control is the product</p><h2 id="control-title">Not one model. Not someone else&apos;s boundary.</h2></div>
        <div className="control-grid">
          {controlDimensions.map((dimension, index) => (
            <article className="control-card" key={dimension.label}><div className="card-top"><span>0{index + 1}</span><span>{dimension.label}</span></div><h3>{dimension.title}</h3><p>{dimension.body}</p></article>
          ))}
        </div>
      </section>

      <section className="comparison" id="compare" aria-labelledby="compare-title">
        <div className="comparison-intro"><div><p className="eyebrow">Three approaches</p><h2 id="compare-title">Convenience and control do not have to trade places.</h2></div><p>OpenClaw gives you control and the operating burden. Grok Bot makes the machinery disappear inside a vendor service. Chatticus is being built for teams that want a polished agent organization inside a boundary they own.</p></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">Capability</th><th scope="col">OpenClaw</th><th scope="col">Grok Bot</th><th className="chatticus-column" scope="col">Chatticus</th></tr></thead>
            <tbody>{comparison.map(([capability, openClaw, grok, chatticus]) => <tr key={capability}><th scope="row">{capability}</th><td>{openClaw}</td><td>{grok}</td><td className="chatticus-column">{chatticus}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="comparison-cards" aria-label="Agent system comparison">
          {comparison.map(([capability, openClaw, grok, chatticus]) => (
            <article className="comparison-card" key={capability}>
              <h3>{capability}</h3>
              <dl>
                <div><dt>OpenClaw</dt><dd>{openClaw}</dd></div>
                <div><dt>Grok Bot</dt><dd>{grok}</dd></div>
                <div className="chatticus-value"><dt>Chatticus</dt><dd>{chatticus}</dd></div>
              </dl>
            </article>
          ))}
        </div>
        <p className="comparison-note">Comparison based on public product documentation as of August 2026. The Chatticus column describes the intended product design; the project is under active development. Sources: <a href="https://openclaw.ai/blog/introducing-openclaw">OpenClaw introduction</a>, <a href="https://docs.x.ai/grok-bot/overview">Grok Bot overview</a>, and <a href="https://docs.x.ai/grok-bot/faq">Grok Bot FAQ</a>.</p>
      </section>

      <section className="economics" aria-labelledby="economics-title">
        <div><p className="eyebrow">Maximize value, not intelligence</p><h2 id="economics-title">Pay for accepted work, not model prestige.</h2></div>
        <div className="economics-copy">
          <p>A model that costs less but creates fifteen minutes of cleanup is not cheaper. Chatticus is designed around routing policy: start with the least expensive model that clears the quality bar, then escalate with concrete evidence when the work demands more.</p>
          <div className="metric-row"><span>Measure</span><strong>accepted outcomes</strong><span>÷</span><strong>model + tools + repair time</strong></div>
          <div className="reading-list"><span>The thinking behind Chatticus</span><a href="https://anth.us/blog/grok-bot-gave-my-coding-agents-a-boss/">Grok Bot Gave My Coding Agents a Boss ↗</a><a href="https://anth.us/blog/from-pair-programmer-to-executive/">From pair programmer to executive ↗</a><a href="https://anth.us/blog/ai-coding-cost-collapse-2026/">The Year Coding Became a Commodity ↗</a><a href="https://anth.us/blog/maximize-value-not-intelligence/">Maximize Value, Not Intelligence ↗</a></div>
        </div>
      </section>

      <footer><a className="wordmark" href="#top">chatticus<span>.</span></a><p>Your agents. Your models. Your cloud.</p></footer>
    </main>
  );
}
