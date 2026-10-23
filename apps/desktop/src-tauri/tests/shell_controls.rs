// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

//! CA-38: the dynamic half of the six shell controls of ADR-0057 section 2.
//!
//! `harness = false`: a real WKWebView needs the main thread of its process.
//! The binary has two roles. Run bare (what `cargo test` does), it is the
//! orchestrator: it opens a control server on the loopback, spawns itself as a
//! child that runs the real shell on the real runtime with a probe injected
//! into the page, and counts what the child reports, what reached the control
//! server and what `lsof` shows for the child. Run with `--child=...`, it is
//! that shell.
//!
//! Every control has a red variant: the same vector run against a shell
//! without the control must see the violation. A vector that stays green
//! without its control proves nothing and fails the run.

#[cfg(not(target_os = "macos"))]
fn main() -> std::process::ExitCode {
    eprintln!("unavailable: the shell controls run on macOS (WKWebView)");
    std::process::ExitCode::FAILURE
}

#[cfg(target_os = "macos")]
fn main() -> std::process::ExitCode {
    macos::main()
}

#[cfg(target_os = "macos")]
mod macos {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, ExitCode, Stdio};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, mpsc};
    use std::thread;
    use std::time::{Duration, Instant};

    use serde_json::Value;
    use tauri::WebviewWindowBuilder;
    use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
    use tauri::webview::InvokeRequest;

    type Failure = String;

    use libre_ai_p04_desktop::context;

    /// A registered command that `build.rs` does not declare: the handler would
    /// answer if the ACL let the call through.
    #[tauri::command]
    fn probe_undeclared() -> &'static str {
        "reached-the-handler"
    }

    const CHILD_DEADLINE: Duration = Duration::from_secs(60);
    const HOLD_AFTER_REPORT: Duration = Duration::from_millis(3000);
    const SAMPLE_EVERY: Duration = Duration::from_millis(250);

    pub fn main() -> ExitCode {
        let arguments: Vec<String> = std::env::args().skip(1).collect();
        let result = match arguments.iter().find_map(|a| a.strip_prefix("--child=")) {
            Some(spec) => child(spec),
            None => orchestrate(),
        };
        match result {
            Ok(()) => ExitCode::SUCCESS,
            Err(failure) => {
                eprintln!("shell_controls FAILED: {failure}");
                ExitCode::FAILURE
            }
        }
    }

    // ---------------------------------------------------------------- child

    /// Which control is removed from the shell the child runs (red variants).
    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    enum Variant {
        Product,
        /// C1 and C3 removed: no CSP, so the page may reach the control server.
        CspOpen,
        /// C1 removed: the window is built without the navigation guard.
        NavigationOpen,
        /// C4 removed: the window is not incognito.
        Persistent,
    }

    impl Variant {
        fn parse(text: &str) -> Result<Self, Failure> {
            match text {
                "product" => Ok(Self::Product),
                "csp-open" => Ok(Self::CspOpen),
                "navigation-open" => Ok(Self::NavigationOpen),
                "persistent" => Ok(Self::Persistent),
                other => Err(format!("unknown variant {other}")),
            }
        }

        fn name(self) -> &'static str {
            match self {
                Self::Product => "product",
                Self::CspOpen => "csp-open",
                Self::NavigationOpen => "navigation-open",
                Self::Persistent => "persistent",
            }
        }
    }

    const PROBE: &str = r#"
(() => {
  const BASE = "http://127.0.0.1:__PORT__";
  const PHASE = "__PHASE__";
  const MARK = "p04-synthetic-marker";
  const done = (promise) => promise.then(() => "reached", () => "refused");
  const timeout = (ms) => new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
  // WebKit may throw from the constructor itself when the policy forbids the
  // connection (WebSocket): that is a refusal, not an end of the probe.
  const attempt = async (run) => {
    try { return await Promise.race([run(), timeout(4000)]); } catch (error) { return "refused"; }
  };
  const step = (name) => { document.title = "P04STEP " + name; };

  const exchange = {
    fetch: () => done(fetch(BASE + "/fetch")),
    xhr: () => new Promise((resolve) => {
      const request = new XMLHttpRequest();
      request.onload = () => resolve("reached");
      request.onerror = () => resolve("refused");
      request.open("GET", BASE + "/xhr");
      request.send();
    }),
    image: () => new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve("reached");
      image.onerror = () => resolve("refused");
      image.src = BASE + "/image";
    }),
    script: () => new Promise((resolve) => {
      const script = document.createElement("script");
      script.onload = () => resolve("reached");
      script.onerror = () => resolve("refused");
      script.src = BASE + "/script";
      document.head.appendChild(script);
    }),
    popup: () => new Promise((resolve) => {
      const opened = window.open(BASE + "/popup");
      setTimeout(() => resolve(opened === null ? "refused" : "reached"), 300);
    }),
    websocket: () => new Promise((resolve) => {
      const socket = new WebSocket("ws://127.0.0.1:__PORT__/ws");
      socket.onopen = () => resolve("reached");
      socket.onerror = () => resolve("refused");
    }),
  };

  const stores = {
    localStorage: {
      write: async () => { localStorage.setItem("p04", MARK); return localStorage.getItem("p04") === MARK; },
      read: async () => localStorage.getItem("p04") === MARK,
    },
    indexedDB: {
      write: () => new Promise((resolve, reject) => {
        const open = indexedDB.open("p04-probe", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("s");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction("s", "readwrite");
          tx.objectStore("s").put(MARK, "k");
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        };
      }),
      read: () => new Promise((resolve, reject) => {
        const open = indexedDB.open("p04-probe", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("s");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const get = open.result.transaction("s", "readonly").objectStore("s").get("k");
          get.onsuccess = () => resolve(get.result === MARK);
          get.onerror = () => reject(get.error);
        };
      }),
    },
  };

  document.addEventListener("DOMContentLoaded", async () => {
    const report = { phase: PHASE };

    if (PHASE === "write") {
      report.exchange = {};
      for (const [name, run] of Object.entries(exchange)) {
        step(name);
        report.exchange[name] = await attempt(run);
      }

      step("bridge");
      report.bridge = {};
      try { report.bridge.declared = await window.__TAURI_INTERNALS__.invoke("shell_ping"); }
      catch (error) { report.bridge.declared = "refused: " + error; }
      try { report.bridge.undeclared = await window.__TAURI_INTERNALS__.invoke("probe_undeclared"); }
      catch (error) { report.bridge.undeclared = "refused: " + error; }

      step("script-policy");
      report.script = {};
      try { new Function("return 1")(); report.script.eval = "reached"; } catch (error) { report.script.eval = "refused"; }
      window.__p04_inline = false;
      const inline = document.createElement("script");
      inline.textContent = "window.__p04_inline = true;";
      document.head.appendChild(inline);
      report.script.inline = window.__p04_inline ? "reached" : "refused";
      // `freezePrototype`: a page script cannot pollute the prototype the IPC glue relies on.
      report.script.prototype = Object.isFrozen(Object.prototype) ? "frozen" : "mutable";
    }

    step("store");
    report.store = {};
    for (const [name, store] of Object.entries(stores)) {
      try {
        report.store[name] = PHASE === "write" ? await store.write() : await store.read();
      } catch (error) {
        report.store[name] = "error: " + error;
      }
    }

    document.title = "P04REPORT " + JSON.stringify(report);

    if (PHASE === "write") {
      // Last: a top-level navigation out of the private scheme.
      setTimeout(() => { window.location.href = BASE + "/navigation"; }, 200);
    }
  });
})();
"#;

    fn child(spec: &str) -> Result<(), Failure> {
        let mut fields = spec.split(',');
        let variant = Variant::parse(fields.next().ok_or("child: variant missing")?)?;
        let phase = fields.next().ok_or("child: phase missing")?.to_owned();
        let port = fields.next().ok_or("child: port missing")?.to_owned();
        let script = PROBE
            .replace("__PORT__", &port)
            .replace("__PHASE__", &phase);

        let mut context = context();
        // Only what a test needs differs from the product: the window stays
        // hidden, and a red variant removes the one control it names.
        let config = context.config_mut();
        let entry = config
            .app
            .windows
            .first_mut()
            .ok_or("no window in tauri.conf.json")?;
        entry.visible = std::env::var_os("P04_SHELL_VISIBLE").is_some();
        entry.focus = false;
        match variant {
            Variant::Product | Variant::NavigationOpen => {}
            Variant::CspOpen => config.app.security.csp = None,
            Variant::Persistent => {
                let entry = config.app.windows.first_mut().ok_or("no window")?;
                entry.incognito = false;
            }
        }
        // The same two calls as `run()`: the window comes from the product's own builder.
        let window_config =
            libre_ai_p04_desktop::take_window_config(&mut context).map_err(|e| e.to_string())?;

        let app = tauri::Builder::default()
            .invoke_handler(tauri::generate_handler![
                libre_ai_p04_desktop::commands::shell_ping,
                probe_undeclared
            ])
            .setup(move |app| {
                let handle = app.handle().clone();
                let builder = if variant == Variant::NavigationOpen {
                    WebviewWindowBuilder::from_config(app, &window_config)?
                } else {
                    libre_ai_p04_desktop::main_window(app, &window_config)?
                };
                builder
                    .initialization_script(script.clone())
                    .on_document_title_changed(move |_, title| {
                        if title.starts_with("P04STEP ") {
                            println!("{title}");
                        } else if let Some(report) = title.strip_prefix("P04REPORT ") {
                            println!("REPORT {report}");
                            let handle = handle.clone();
                            thread::spawn(move || {
                                thread::sleep(HOLD_AFTER_REPORT);
                                handle.exit(0);
                            });
                        }
                    })
                    .build()?;
                Ok(())
            })
            .build(context)
            .map_err(|e| format!("build: {e}"))?;

        // The effective CSP: the header Tauri attaches to the embedded document.
        let csp_header = app
            .asset_resolver()
            .get("index.html".into())
            .and_then(|asset| asset.csp_header);
        println!("CSP {}", csp_header.unwrap_or_default());
        println!("VARIANT {}", variant.name());

        let code = app.run_return(|_, _| {});
        if code == 0 {
            Ok(())
        } else {
            Err(format!("shell exited with {code}"))
        }
    }

    // --------------------------------------------------------- orchestrator

    /// Loopback server the page must not reach. It answers like a permissive
    /// remote would, so a request that gets through is observable.
    struct ControlServer {
        port: u16,
        connections: Arc<AtomicUsize>,
        stop: Arc<AtomicBool>,
        listener: thread::JoinHandle<()>,
    }

    impl ControlServer {
        fn start() -> Result<Self, Failure> {
            let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("bind: {e}"))?;
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            listener.set_nonblocking(true).map_err(|e| e.to_string())?;
            let connections = Arc::new(AtomicUsize::new(0));
            let stop = Arc::new(AtomicBool::new(false));
            let (seen, halt) = (Arc::clone(&connections), Arc::clone(&stop));
            let listener = thread::spawn(move || {
                while !halt.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            seen.fetch_add(1, Ordering::SeqCst);
                            thread::spawn(move || answer(stream));
                        }
                        Err(_) => thread::sleep(Duration::from_millis(20)),
                    }
                }
            });
            Ok(Self {
                port,
                connections,
                stop,
                listener,
            })
        }

        fn connections(&self) -> usize {
            self.connections.load(Ordering::SeqCst)
        }

        fn reset(&self) {
            self.connections.store(0, Ordering::SeqCst);
        }

        fn stop(self) {
            self.stop.store(true, Ordering::SeqCst);
            let _ = self.listener.join();
        }
    }

    fn answer(mut stream: TcpStream) {
        let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
        let mut buffer = [0_u8; 2048];
        let read = stream.read(&mut buffer).unwrap_or(0);
        let request = String::from_utf8_lossy(buffer.get(..read).unwrap_or_default());
        let path = request.split_whitespace().nth(1).unwrap_or("/");
        let (kind, body): (&str, &[u8]) = if path.starts_with("/script") {
            ("application/javascript", b"/* control server */")
        } else if path.starts_with("/image") {
            // 1x1 transparent GIF.
            ("image/gif", b"GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;")
        } else {
            ("text/plain", b"control server")
        };
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(head.as_bytes());
        let _ = stream.write_all(body);
    }

    /// Everything a child printed.
    struct Run {
        report: Value,
        csp: String,
        samples: Vec<Sample>,
    }

    struct Sample {
        processes: usize,
        network_lines: usize,
        listening: usize,
        vanished: usize,
    }

    fn scratch_home() -> Result<PathBuf, Failure> {
        let unique = format!(
            "p04-shell-home-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos()
        );
        let path = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&path).map_err(|e| format!("scratch home: {e}"))?;
        Ok(path)
    }

    /// Spawns this binary as the shell and samples `lsof` on its process tree
    /// until it exits.
    fn run_child(variant: Variant, phase: &str, port: u16, home: &Path) -> Result<Run, Failure> {
        let me = std::env::current_exe().map_err(|e| e.to_string())?;
        let mut child: Child = Command::new(me)
            .arg(format!("--child={},{phase},{port}", variant.name()))
            // Foundation resolves `~` through this variable: whatever WebKit
            // would persist lands in the scratch home, never in the user's.
            .env("CFFIXED_USER_HOME", home)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("spawn: {e}"))?;
        let pid = child.id();
        let stdout = child.stdout.take().ok_or("child stdout missing")?;
        let (lines, received) = mpsc::channel::<String>();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if lines.send(line).is_err() {
                    break;
                }
            }
        });

        let started = Instant::now();
        let mut seen = Seen::default();
        let mut samples = Vec::new();
        loop {
            while let Ok(line) = received.try_recv() {
                seen.take(&line);
            }
            match child.try_wait().map_err(|e| e.to_string())? {
                Some(status) => {
                    while let Ok(line) = received.try_recv() {
                        seen.take(&line);
                    }
                    if !status.success() {
                        return Err(format!(
                            "child {} {phase} exited with {status}",
                            variant.name()
                        ));
                    }
                    break;
                }
                None if started.elapsed() > CHILD_DEADLINE => {
                    let _ = child.kill();
                    return Err(format!(
                        "child {} {phase} exceeded {CHILD_DEADLINE:?}; last probe step: {}",
                        variant.name(),
                        seen.step
                    ));
                }
                None => {}
            }
            // The child needs a moment to be a process lsof can read.
            if started.elapsed() > Duration::from_millis(500) {
                match sample_tree(pid) {
                    Ok(sample) => samples.push(sample),
                    // A child that exited during the sample is not unreadable.
                    Err(failure) => {
                        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
                            let _ = child.kill();
                            return Err(failure);
                        }
                    }
                }
            }
            thread::sleep(SAMPLE_EVERY);
        }
        let report = seen
            .report
            .ok_or_else(|| format!("child {} {phase} sent no report", variant.name()))?;
        Ok(Run {
            report,
            csp: seen.csp,
            samples,
        })
    }

    /// What a child printed so far. Progress steps are kept for the failure message only.
    #[derive(Default)]
    struct Seen {
        report: Option<Value>,
        csp: String,
        step: String,
    }

    impl Seen {
        fn take(&mut self, line: &str) {
            if let Some(json) = line.strip_prefix("REPORT ") {
                self.report = serde_json::from_str(json).ok();
            } else if let Some(header) = line.strip_prefix("CSP ") {
                self.csp = header.to_owned();
            } else if let Some(step) = line.strip_prefix("P04STEP ") {
                self.step = step.to_owned();
            }
        }
    }

    /// Files WebKit keeps for a persistent data store (local storage, IndexedDB)
    /// under the scratch home: a second instrument for C4, independent of what
    /// the page reads back.
    fn persisted_store_files(home: &Path) -> usize {
        fn walk(dir: &Path, found: &mut usize) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, found);
                } else if path.to_string_lossy().contains("/LocalStorage/")
                    || path.to_string_lossy().contains("/IndexedDB/")
                {
                    *found += 1;
                }
            }
        }
        let mut found = 0;
        walk(home, &mut found);
        found
    }

    // ------------------------------------------------------------------ lsof

    fn process_tree(root: u32) -> Result<Vec<u32>, Failure> {
        let output = Command::new("ps")
            .args(["-axo", "pid=,ppid="])
            .output()
            .map_err(|e| format!("ps: {e}"))?;
        let table: Vec<(u32, u32)> = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let mut columns = line.split_whitespace();
                Some((columns.next()?.parse().ok()?, columns.next()?.parse().ok()?))
            })
            .collect();
        let mut tree = vec![root];
        let mut frontier = vec![root];
        while let Some(parent) = frontier.pop() {
            for (pid, ppid) in &table {
                if *ppid == parent && !tree.contains(pid) {
                    tree.push(*pid);
                    frontier.push(*pid);
                }
            }
        }
        Ok(tree)
    }

    /// `lsof -i -P -a -p PID` for the process and its descendants. A process
    /// lsof cannot read is an error: no output would otherwise read as "no port".
    fn sample_tree(root: u32) -> Result<Sample, Failure> {
        let mut sample = Sample {
            processes: 0,
            network_lines: 0,
            listening: 0,
            vanished: 0,
        };
        for pid in process_tree(root)? {
            let everything = Command::new("lsof")
                .args(["-n", "-P", "-p", &pid.to_string()])
                .output()
                .map_err(|e| format!("lsof: {e}"))?;
            if String::from_utf8_lossy(&everything.stdout).lines().count() == 0 {
                // A descendant that exited between `ps` and `lsof` is counted
                // as vanished; a process that still exists and cannot be read
                // would read as "no port", so it is a failure.
                let alive = Command::new("ps")
                    .args(["-p", &pid.to_string(), "-o", "pid="])
                    .output()
                    .map_err(|e| format!("ps: {e}"))?;
                if pid == root || !String::from_utf8_lossy(&alive.stdout).trim().is_empty() {
                    return Err(format!("lsof cannot read process {pid}"));
                }
                sample.vanished += 1;
                continue;
            }
            let network = Command::new("lsof")
                .args(["-n", "-P", "-i", "-a", "-p", &pid.to_string()])
                .output()
                .map_err(|e| format!("lsof: {e}"))?;
            let text = String::from_utf8_lossy(&network.stdout);
            let lines: Vec<&str> = text.lines().filter(|l| !l.starts_with("COMMAND")).collect();
            sample.processes += 1;
            sample.network_lines += lines.len();
            sample.listening += lines.iter().filter(|l| l.contains("(LISTEN)")).count();
        }
        Ok(sample)
    }

    // ------------------------------------------------------------- C5 (mock)

    fn invoke(
        webview: &tauri::WebviewWindow<MockRuntime>,
        command: &str,
    ) -> Result<String, String> {
        let url = "tauri://localhost"
            .parse()
            .map_err(|e| format!("url: {e}"))?;
        get_ipc_response(
            webview,
            InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url,
                body: tauri::ipc::InvokeBody::default(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|body| format!("{body:?}"))
        .map_err(|e| format!("{e:?}"))
    }

    /// Returns (attempts, refused) for undeclared calls on the mock runtime that
    /// applies the ACL generated from `build.rs` and `capabilities/`.
    fn c5_mock() -> Result<(usize, usize), Failure> {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![
                libre_ai_p04_desktop::commands::shell_ping,
                probe_undeclared
            ])
            .build(context())
            .map_err(|e| format!("mock build: {e}"))?;
        let main = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .map_err(|e| e.to_string())?;
        let other = WebviewWindowBuilder::new(&app, "other", Default::default())
            .build()
            .map_err(|e| e.to_string())?;

        // Positive control: a declared command on the declared window is served.
        let pong = invoke(&main, "shell_ping")?;
        if !pong.contains("pong") {
            return Err(format!("C5 positive control: shell_ping answered {pong}"));
        }
        let attempts = [
            (
                "registered but undeclared command",
                invoke(&main, "probe_undeclared"),
            ),
            ("command nobody registered", invoke(&main, "nothing_here")),
            (
                "declared command from an undeclared window",
                invoke(&other, "shell_ping"),
            ),
        ];
        let mut refused = 0;
        for (what, outcome) in &attempts {
            match outcome {
                Err(message) => {
                    println!("C5 mock: refused {what}: {}", first_line(message));
                    refused += 1;
                }
                Ok(body) => println!("C5 mock: ACCEPTED {what}: {body}"),
            }
        }
        Ok((attempts.len(), refused))
    }

    fn first_line(text: &str) -> &str {
        text.lines().next().unwrap_or(text)
    }

    // ---------------------------------------------------------- verdicts

    fn field<'a>(value: &'a Value, path: &[&str]) -> Result<&'a Value, Failure> {
        let mut current = value;
        for key in path {
            current = current
                .get(*key)
                .ok_or_else(|| format!("report lacks {}", path.join(".")))?;
        }
        Ok(current)
    }

    fn text<'a>(value: &'a Value, path: &[&str]) -> Result<&'a str, Failure> {
        field(value, path)?
            .as_str()
            .ok_or_else(|| format!("{} is not text", path.join(".")))
    }

    /// Exchanges the page attempted, and how many its own handlers saw refused.
    fn exchanges(report: &Value) -> Result<(usize, usize), Failure> {
        let map = field(report, &["exchange"])?
            .as_object()
            .ok_or("exchange is not an object")?;
        let refused = map
            .values()
            .filter(|v| v.as_str() == Some("refused"))
            .count();
        Ok((map.len(), refused))
    }

    fn stored(report: &Value) -> Result<(usize, usize), Failure> {
        let map = field(report, &["store"])?
            .as_object()
            .ok_or("store is not an object")?;
        let kept = map.values().filter(|v| v.as_bool() == Some(true)).count();
        Ok((map.len(), kept))
    }

    fn orchestrate() -> Result<(), Failure> {
        let mut problems: Vec<String> = Vec::new();
        let mut red_seen = 0_usize;
        let mut check = |ok: bool, what: String| -> bool {
            if !ok {
                problems.push(what);
            }
            ok
        };

        // C5: the ACL on the mock runtime.
        let (c5_attempts, c5_refused) = c5_mock()?;
        check(
            c5_attempts > 0 && c5_refused == c5_attempts,
            format!("C5 mock: {c5_refused} refused of {c5_attempts}"),
        );

        let server = ControlServer::start()?;
        let home = scratch_home()?;
        let outcome = (|| -> Result<(), Failure> {
            // The product shell: write phase, then a restart that reads back.
            server.reset();
            let write = run_child(Variant::Product, "write", server.port, &home)?;
            let reached = server.connections();
            // The page's own handlers see the exchanges; the top-level navigation
            // unloads the page, so only the control server can see it.
            let (page_attempts, c1_refused_by_page) = exchanges(&write.report)?;
            let c1_attempts = page_attempts + 1;
            let c1_refused = c1_attempts.saturating_sub(reached.min(c1_attempts));
            println!(
                "C1 product: {c1_attempts} tentatives hors schema, {c1_refused} refus comptes ({c1_refused_by_page} vus par la page), {reached} connexion(s) recue(s) par le serveur de controle"
            );
            check(
                page_attempts >= 6 && reached == 0 && c1_refused_by_page == page_attempts,
                format!(
                    "C1: {reached} connexion(s) abouties, {c1_refused_by_page}/{page_attempts} refus vus par la page"
                ),
            );

            let c3_eval = text(&write.report, &["script", "eval"])?;
            let c3_inline = text(&write.report, &["script", "inline"])?;
            println!(
                "C3 product: CSP effective [{}] ; eval {c3_eval} ; script inline {c3_inline}",
                write.csp
            );
            check(
                write.csp.contains("default-src 'none'")
                    && c3_eval == "refused"
                    && c3_inline == "refused",
                format!("C3: CSP [{}] eval {c3_eval} inline {c3_inline}", write.csp),
            );

            let declared = text(&write.report, &["bridge", "declared"])?;
            let undeclared = text(&write.report, &["bridge", "undeclared"])?;
            let frozen = text(&write.report, &["script", "prototype"])?;
            println!(
                "C5 product: declared -> {declared} ; undeclared -> {undeclared} ; Object.prototype {frozen}"
            );
            check(
                declared == "pong" && undeclared.starts_with("refused") && frozen == "frozen",
                format!("C5: declared {declared}, undeclared {undeclared}, prototype {frozen}"),
            );

            let (stores, written) = stored(&write.report)?;
            let read = run_child(Variant::Product, "read", server.port, &home)?;
            let (_, survivors) = stored(&read.report)?;
            let c4_refused = written.saturating_sub(survivors);
            let on_disk = persisted_store_files(&home);
            println!(
                "C4 product: {written} ecriture(s) acceptee(s) sur {stores} magasin(s), {survivors} relue(s) apres redemarrage, soit {c4_refused} refus comptes ; {on_disk} fichier(s) de magasin persistant sur disque"
            );
            check(
                written > 0 && survivors == 0 && on_disk == 0,
                format!(
                    "C4: {written} written, {survivors} survived a restart, {on_disk} store file(s) on disk"
                ),
            );

            // C6: lsof on the child tree, with the self-check that the instrument sees a port.
            let listening: usize = write
                .samples
                .iter()
                .chain(read.samples.iter())
                .map(|s| s.listening)
                .sum();
            let lines: usize = write
                .samples
                .iter()
                .chain(read.samples.iter())
                .map(|s| s.network_lines)
                .sum();
            let processes: usize = write
                .samples
                .iter()
                .chain(read.samples.iter())
                .map(|s| s.processes)
                .sum();
            let sampled = write.samples.len() + read.samples.len();
            println!(
                "C6 product: {listening} port(s) en ecoute, {lines} ligne(s) reseau, {processes} lecture(s) de processus sur {sampled} echantillon(s)"
            );
            check(
                sampled > 0 && listening == 0,
                format!("C6: {listening} listening over {sampled} samples"),
            );
            let own = sample_tree(std::process::id())?;
            println!(
                "C6 vecteur rouge (ecouteur TCP volontaire dans le processus de test): {} port(s) en ecoute vu(s)",
                own.listening
            );
            red_seen += usize::from(check(
                own.listening >= 1,
                "C6 red vector: lsof did not see the deliberate listener".to_owned(),
            ));

            // Red variants: each control removed, its vector must see the violation.
            server.reset();
            let open = run_child(Variant::CspOpen, "write", server.port, &home)?;
            let open_reached = server.connections();
            let (open_attempts, open_page_refused) = exchanges(&open.report)?;
            println!(
                "C1/C3 variante rouge (CSP retiree): {open_reached} connexion(s) recue(s), {open_page_refused}/{open_attempts} refus vus par la page"
            );
            red_seen += usize::from(check(
                open_reached >= 1,
                "C1/C3 red variant: the control server saw no connection without the CSP"
                    .to_owned(),
            ));

            server.reset();
            run_child(Variant::NavigationOpen, "write", server.port, &home)?;
            let navigated = server.connections();
            println!(
                "C1 variante rouge (garde de navigation retire): {navigated} connexion(s) recue(s)"
            );
            red_seen += usize::from(check(
                navigated >= 1,
                "C1 red variant: the control server saw no connection without the navigation guard"
                    .to_owned(),
            ));

            let persistent_home = scratch_home()?;
            let persistent_write =
                run_child(Variant::Persistent, "write", server.port, &persistent_home)?;
            let (_, persistent_written) = stored(&persistent_write.report)?;
            let persistent_read =
                run_child(Variant::Persistent, "read", server.port, &persistent_home)?;
            let (_, persistent_survivors) = stored(&persistent_read.report)?;
            let persistent_files = persisted_store_files(&persistent_home);
            println!(
                "C4 variante rouge (fenetre non incognito): {persistent_written} ecriture(s), {persistent_survivors} relue(s) apres redemarrage, {persistent_files} fichier(s) de magasin persistant sur disque"
            );
            let _ = std::fs::remove_dir_all(&persistent_home);
            red_seen += usize::from(check(
                persistent_survivors >= 1 && persistent_files >= 1,
                "C4 red variant: nothing persisted without incognito".to_owned(),
            ));

            println!(
                "shell_controls: refus comptes: C1 {c1_refused}/{c1_attempts} (hors schema), C5 {c5_refused}/{c5_attempts} (mock) + 1/1 (coquille), C4 {c4_refused}/{written} (ecritures non persistees), C6 {listening} port(s) en ecoute ; variantes rouges vues rouges: {red_seen}/4"
            );
            Ok(())
        })();
        let _ = std::fs::remove_dir_all(&home);
        server.stop();
        outcome?;

        if problems.is_empty() {
            println!("shell_controls: OK");
            Ok(())
        } else {
            Err(problems.join(" ; "))
        }
    }
}
