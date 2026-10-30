const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer } = require("../lib/rendererTestHarness");

test("version history renders selectable, read-only comparison and delegates restore", async (t) => {
  const { Window } = await import("happy-dom");
  const browser = new Window();
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  for (const name of ["window", "document", "navigator", "Node", "Element", "HTMLElement"])
    define(name, name === "window" ? browser : browser[name]);
  const React = require("react");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const vite = await createRendererServer(t);
  const { VersionHistory } = await vite.ssrLoadModule(
    "/custom-features/transcript-studio/components/VersionHistory.tsx"
  );
  const { createRoot } = require("react-dom/client");
  const host = browser.document.createElement("div");
  browser.document.body.appendChild(host);
  const root = createRoot(host);
  let selected = "v1";
  let restores = 0;
  const render = () =>
    React.createElement(VersionHistory, {
      versions: [
        { versionId: "v1", version: 1, description: "Manual checkpoint", createdAt: null },
        { versionId: "v2", version: 2, description: "Accepted AI edits", createdAt: null },
      ],
      selectedVersionId: selected,
      currentText: "Current words",
      comparedText: "Earlier words",
      canRestore: true,
      onSelect: (value) => {
        selected = value;
      },
      onRestore: () => {
        restores += 1;
      },
    });
  t.after(async () => {
    await React.act(async () => root.unmount());
    host.remove();
    await browser.happyDOM.close();
  });
  await React.act(async () => root.render(render()));
  assert.match(host.textContent, /Earlier words/);
  assert.match(host.textContent, /Current words/);
  assert.equal(host.querySelector("pre").getAttribute("contenteditable"), null);
  const select = host.querySelector("select");
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), "value").set;
  setter.call(select, "v2");
  await React.act(async () => select.dispatchEvent(new browser.Event("change", { bubbles: true })));
  assert.equal(selected, "v2");
  const restore = [...host.querySelectorAll("button")].find((button) =>
    button.textContent.includes("Restore selected version")
  );
  await React.act(async () => restore.click());
  assert.equal(restores, 1);
});
