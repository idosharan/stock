(function () {
  const installButton = document.getElementById('install-app');
  const openHelpButton = document.getElementById('open-app-help');
  const closeHelpButton = document.getElementById('close-app-help');
  const helpDialog = document.getElementById('app-help');
  const helpManagement = document.getElementById('help-management');
  const appStatus = document.getElementById('app-status');
  const manager = document.getElementById('manage-reports');
  if (!installButton || !openHelpButton || !closeHelpButton || !helpDialog || !helpManagement || !appStatus) return;

  let deferredPrompt = null;
  let lastFocus = openHelpButton;

  function setStatus(message, state) {
    appStatus.textContent = message;
    if (state) appStatus.dataset.state = state;
    else delete appStatus.dataset.state;
  }

  function isStandalone() {
    return (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  }

  function syncManagementLink() {
    let safeHref = '';
    try {
      const value = manager && typeof manager.href === 'string' ? manager.href : '';
      const parsed = value ? new URL(value, document.baseURI) : null;
      if (parsed && parsed.protocol === 'https:' && parsed.hostname === 'github.com' && /^\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+\/actions\/workflows\/reports\.yml$/.test(parsed.pathname))
        safeHref = parsed.href;
    } catch {}
    helpManagement.hidden = !safeHref;
    if (safeHref) helpManagement.href = safeHref;
  }

  function updateInstallVisibility() {
    installButton.hidden = !deferredPrompt || isStandalone();
  }

  function openHelp() {
    lastFocus = openHelpButton;
    syncManagementLink();
    helpDialog.showModal();
  }

  function closeHelp() {
    if (!helpDialog.open) return;
    helpDialog.close('close');
  }

  installButton.hidden = true;
  syncManagementLink();

  openHelpButton.addEventListener('click', (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    openHelp();
  });
  closeHelpButton.addEventListener('click', (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    closeHelp();
  });
  helpDialog.addEventListener('cancel', (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    helpDialog.close('cancel');
  });
  helpDialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closeHelp();
  });
  helpDialog.addEventListener('close', () => {
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  });

  addEventListener('beforeinstallprompt', (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    deferredPrompt = event;
    updateInstallVisibility();
    if (!isStandalone()) setStatus('הדפדפן מאפשר התקנה. לחצו על התקנת האפליקציה כדי לאשר ידנית.', 'ready');
  });

  addEventListener('appinstalled', () => {
    deferredPrompt = null;
    installButton.hidden = true;
    setStatus('האפליקציה הותקנה. הדוחות נטענים מהרשת; המחירים אינם בזמן אמת.', 'ready');
  });

  installButton.addEventListener('click', async (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (!deferredPrompt || isStandalone()) return;
    const promptEvent = deferredPrompt;
    deferredPrompt = null;
    installButton.hidden = true;
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice && choice.outcome === 'accepted') {
        setStatus('בקשת ההתקנה אושרה. לאחר ההתקנה האפליקציה תיפתח כחלון עצמאי.', 'ready');
        return;
      }
      setStatus('ההתקנה נדחתה. אפשר להשתמש בתפריט Chrome ב-Android להוספה למסך הבית.', 'warn');
    } catch {
      setStatus('ההתקנה לא הושלמה. אפשר להשתמש בהוספה למסך הבית מתוך Chrome ב-Android.', 'warn');
    }
  });

  const secureHttp = /^https?:$/.test(location.protocol) && isSecureContext;
  if (!secureHttp) {
    setStatus('ללא התקנה אוטומטית: פתחו את האתר ב-Chrome ב-Android דרך חיבור מאובטח HTTPS כדי לקבל הצעת התקנה.', 'warn');
    return;
  }
  if (!navigator.serviceWorker || typeof navigator.serviceWorker.register !== 'function') {
    setStatus('Service Worker אינו זמין בדפדפן הזה. אפשר להמשיך דרך האתר הרגיל ולפתוח את המדריך.', 'warn');
    return;
  }
  if (isStandalone()) {
    installButton.hidden = true;
    setStatus('האפליקציה כבר פתוחה במצב עצמאי. הדוחות עדיין נטענים ישירות מהרשת.', 'ready');
  }

  const base = new URL('./', document.baseURI);
  const scriptUrl = new URL('./service-worker.js', document.baseURI);
  navigator.serviceWorker.register(scriptUrl.href, { scope: base.href }).catch(() => {
    setStatus('Service Worker לא הופעל. אפשר להמשיך להשתמש באתר, והתקנה תהיה זמינה רק כשהדפדפן והחיבור יתמכו בכך.', 'error');
  });
})();