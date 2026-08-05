/**
 * フィードバックウィジェット（React を使っていない自社サイト向けの素の JS 版）
 *
 * 使い方:
 *   <script
 *     src="https://<dashboard-host>/feedback-widget.js"
 *     data-app-slug="mysupport"
 *     data-endpoint="https://xxxx.supabase.co/functions/v1/submit-feedback"
 *     defer></script>
 *
 * 右下にボタンを出し、クリックでフォームを開く。
 * Shadow DOM に閉じ込めてあるので、埋め込み先の CSS と干渉しない。
 */
(function () {
  "use strict";

  var script = document.currentScript ||
    document.querySelector('script[src*="feedback-widget.js"]');
  if (!script) return;

  var appSlug = script.getAttribute("data-app-slug");
  var endpoint = script.getAttribute("data-endpoint");
  var label = script.getAttribute("data-label") || "ご意見";
  var title = script.getAttribute("data-title") || "ご意見・ご要望";

  if (!appSlug || !endpoint) {
    console.error("[feedback-widget] data-app-slug と data-endpoint は必須です");
    return;
  }

  var host = document.createElement("div");
  host.setAttribute("data-feedback-widget", appSlug);
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: "open" });

  root.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '*{box-sizing:border-box;font-family:system-ui,-apple-system,"Hiragino Sans",Meiryo,sans-serif}' +
    '.launcher{position:fixed;right:20px;bottom:20px;z-index:2147483000;background:#0f172a;color:#fff;' +
    'border:0;border-radius:9999px;padding:12px 18px;font-size:14px;cursor:pointer;box-shadow:0 6px 20px rgba(15,23,42,.25)}' +
    '.panel{position:fixed;right:20px;bottom:76px;z-index:2147483000;width:340px;max-width:calc(100vw - 40px);' +
    'background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 12px 32px rgba(15,23,42,.18);padding:16px;display:none}' +
    '.panel[data-open="1"]{display:block}' +
    'h2{margin:0 0 10px;font-size:14px;color:#0f172a}' +
    'textarea,input[type=email]{width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:8px 10px;font-size:14px;color:#0f172a}' +
    'textarea{min-height:96px;resize:vertical}' +
    'label{display:block;font-size:12px;color:#475569;margin-top:8px}' +
    '.row{display:flex;align-items:center;gap:10px;margin-top:12px}' +
    'button.send{background:#0f172a;color:#fff;border:0;border-radius:8px;padding:8px 16px;font-size:14px;cursor:pointer}' +
    'button.send[disabled]{opacity:.5;cursor:default}' +
    'button.close{margin-left:auto;background:none;border:0;color:#64748b;font-size:12px;cursor:pointer;text-decoration:underline}' +
    '.msg{margin-top:10px;font-size:13px}' +
    '.msg.err{color:#dc2626}.msg.ok{color:#047857}' +
    '.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}' +
    '</style>' +
    '<button class="launcher" type="button">' + escapeHtml(label) + '</button>' +
    '<div class="panel" role="dialog" aria-modal="false">' +
    '  <h2>' + escapeHtml(title) + '</h2>' +
    '  <textarea placeholder="気づいた点や困っていることを自由にお書きください" maxlength="5000"></textarea>' +
    '  <label>返信先メールアドレス（任意）<input type="email" /></label>' +
    '  <div class="hp"><label>この欄は入力しないでください<input type="text" tabindex="-1" autocomplete="off" /></label></div>' +
    '  <div class="row"><button class="send" type="button">送信</button>' +
    '  <button class="close" type="button">閉じる</button></div>' +
    '  <div class="msg"></div>' +
    '</div>';

  var launcher = root.querySelector(".launcher");
  var panel = root.querySelector(".panel");
  var textarea = root.querySelector("textarea");
  var emailInput = root.querySelector('input[type="email"]');
  var honeypot = root.querySelector(".hp input");
  var sendBtn = root.querySelector(".send");
  var closeBtn = root.querySelector(".close");
  var msg = root.querySelector(".msg");

  launcher.addEventListener("click", function () {
    var open = panel.getAttribute("data-open") === "1";
    panel.setAttribute("data-open", open ? "0" : "1");
    if (!open) textarea.focus();
  });

  closeBtn.addEventListener("click", function () {
    panel.setAttribute("data-open", "0");
  });

  sendBtn.addEventListener("click", function () {
    var text = (textarea.value || "").trim();
    if (!text) return;

    setMessage("", "");
    sendBtn.disabled = true;
    sendBtn.textContent = "送信中…";

    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_slug: appSlug,
        message: text,
        email: (emailInput.value || "").trim() || undefined,
        page_url: window.location.href,
        _hp: honeypot.value || "",
      }),
    })
      .then(function (res) {
        if (res.status === 429) {
          throw new Error("送信が集中しています。しばらく待ってからお試しください。");
        }
        if (!res.ok) throw new Error("送信に失敗しました (" + res.status + ")");
        textarea.value = "";
        emailInput.value = "";
        setMessage("ご意見ありがとうございました。", "ok");
      })
      .catch(function (err) {
        setMessage(err && err.message ? err.message : "送信に失敗しました", "err");
      })
      .finally(function () {
        sendBtn.disabled = false;
        sendBtn.textContent = "送信";
      });
  });

  function setMessage(text, kind) {
    msg.textContent = text;
    msg.className = "msg" + (kind ? " " + kind : "");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
})();
