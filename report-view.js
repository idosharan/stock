(function () {
  function compactReport(reportDocument) {
    const report = reportDocument.querySelector('main.report');
    if (!report || report.dataset.compact === 'true') return;
    report.dataset.compact = 'true';
    const sections = Array.from(report.children).filter(section =>
      section.tagName === 'SECTION' && !['summary', 'alerts', 'portfolio', 'data-health'].includes(section.id)
      && !['portfolio', 'sell', 'executive'].some(name => section.classList.contains(name)));
    const folds = [];
    for (const section of sections) {
      const heading = Array.from(section.children).find(child => child.tagName === 'H2');
      if (!heading) continue;
      const disclosure = reportDocument.createElement('details');
      const summary = reportDocument.createElement('summary');
      for (const attribute of section.attributes) disclosure.setAttribute(attribute.name, attribute.value);
      disclosure.classList.add('report-fold');
      summary.append(heading);
      disclosure.append(summary);
      while (section.firstChild) disclosure.append(section.firstChild);
      section.replaceWith(disclosure);
      folds.push(disclosure);
    }
    const style = reportDocument.createElement('style');
    style.textContent = '.report>.report-fold{margin:12px 0;border-top:1px solid var(--line,#ddd)}' +
      '.report>.report-fold:not([open]){padding:0;background:transparent;border-bottom:0}' +
      '.report-fold>summary{padding:14px 4px;cursor:pointer;color:inherit;list-style:revert}' +
      '.report-fold>summary h2{display:inline;margin:0;font-size:16px;line-height:1.6;letter-spacing:0;overflow-wrap:anywhere}' +
      '.report-fold[open]>summary{margin-bottom:12px}.report-fold>summary:focus-visible{outline:2px solid #14755b;outline-offset:2px}' +
      '.report-expand-all{font:inherit;font-size:12px;cursor:pointer;border:1px solid var(--line,#ddd);border-radius:4px;background:transparent;color:inherit;padding:6px 10px;white-space:nowrap}' +
      '@media print{.report-expand-all{display:none}.report-fold{break-inside:auto}}';
    reportDocument.head.append(style);
    const navigation = report.querySelector('.section-nav');
    const expandButton = reportDocument.createElement('button');
    expandButton.type = 'button';
    expandButton.className = 'report-expand-all';
    function syncButton() {
      const allOpen = folds.length > 0 && folds.every(disclosure => disclosure.open);
      expandButton.textContent = allOpen ? 'סגירת הפירוט' : 'פתיחת כל הפירוט';
      expandButton.setAttribute('aria-expanded', String(allOpen));
    }
    expandButton.addEventListener('click', () => {
      const open = !folds.every(disclosure => disclosure.open);
      folds.forEach(disclosure => { disclosure.open = open; });
      syncButton();
    });
    folds.forEach(disclosure => disclosure.addEventListener('toggle', syncButton));
    if (folds.length) {
      if (navigation) navigation.append(expandButton);
      else report.insertBefore(expandButton, folds[0]);
    }
    syncButton();

    function reveal(hash) {
      let identifier;
      try { identifier = decodeURIComponent(hash.slice(1)); } catch { return; }
      const target = reportDocument.getElementById(identifier);
      if (!target) return;
      let ancestor = target;
      while (ancestor && ancestor !== report) {
        if (ancestor.tagName === 'DETAILS') ancestor.open = true;
        ancestor = ancestor.parentElement;
      }
      target.scrollIntoView({ block: 'start' });
      syncButton();
    }
    report.addEventListener('click', event => {
      const link = event.target.closest('a[href^="#"]');
      if (link) reveal(link.getAttribute('href'));
    });
    const reportWindow = reportDocument.defaultView;
    if (reportWindow) {
      reportWindow.addEventListener('hashchange', () => reveal(reportWindow.location.hash));
      if (reportWindow.location.hash) reveal(reportWindow.location.hash);
      let printClosed = [];
      reportWindow.addEventListener('beforeprint', () => {
        printClosed = Array.from(report.querySelectorAll('details')).filter(disclosure => !disclosure.open);
        printClosed.forEach(disclosure => { disclosure.open = true; });
      });
      reportWindow.addEventListener('afterprint', () => {
        printClosed.forEach(disclosure => { disclosure.open = false; });
        printClosed = [];
      });
    }
  }

  compactReport(document);
  const frame = document.getElementById('frame');
  if (frame) {
    const compactFrame = () => {
      try { if (frame.contentDocument) compactReport(frame.contentDocument); } catch {}
    };
    frame.addEventListener('load', compactFrame);
    compactFrame();
  }
})();