/* Python runs off the UI thread; request payloads are data, never Python code. */
let runtime;
async function initialize() {
  importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js');
  const py = await loadPyodide({indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/'});
  for (const name of ['engine.py', 'season_dates.py', 'web_bridge.py']) {
    const response = await fetch(name);
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    py.FS.writeFile(name, await response.text());
  }
  py.runPython('from web_bridge import dispatch');
  return py;
}
let chain = Promise.resolve();
self.onmessage = ({data}) => {
  chain = chain.then(async () => {
    try {
      runtime ??= initialize();
      const py = await runtime;
      py.globals.set('request_json', JSON.stringify(data.request));
      const result = JSON.parse(py.runPython('dispatch(request_json)'));
      self.postMessage({id: data.id, result});
    } catch (error) {
      self.postMessage({id: data.id, error: String(error.message || error)});
    }
  });
};
