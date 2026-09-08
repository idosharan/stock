(function () {
  function compactReport(reportDocument) {
    const report = reportDocument.querySelector('main.report');
    if (!report || report.dataset.compact === 'true') return;
    report.dataset.compact = 'true';
    for (const table of report.querySelectorAll('.portfolio table')) {
      const headings = Array.from(table.querySelectorAll('thead th'));
      const rows = Array.from(table.querySelectorAll('tbody tr'));
      if (!headings.length || rows.some(row => row.cells.length !== headings.length)) continue;
      table.classList.add('mobile-portfolio');
      table.setAttribute('role', 'table');
      table.querySelectorAll('thead,tbody').forEach(group => group.setAttribute('role', 'rowgroup'));
      table.querySelectorAll('tr').forEach(row => row.setAttribute('role', 'row'));
      headings.forEach(heading => {
        heading.setAttribute('scope', 'col');
        heading.setAttribute('role', 'columnheader');
      });
      for (const row of rows) {
        Array.from(row.cells).forEach((cell, index) => {
          cell.dataset.label = headings[index].textContent.trim();
          cell.setAttribute('role', 'cell');
        });
      }
    }
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
      '@media screen and (max-width:760px){.report .table-wrap{max-height:none}.report summary,.report .section-nav a,.report-expand-all,.ranking-toolbar input,.sort-button{min-height:44px}.ranking-toolbar input{font-size:16px}.report .section-nav{flex-wrap:nowrap;overflow-x:auto;gap:16px}.report .section-nav a{flex-shrink:0;white-space:nowrap}.report-expand-all{flex-shrink:0}}' +
      '@media screen and (max-width:640px){html,body{margin:0;max-width:100%}.report{margin:0;padding:12px;min-width:0;max-width:100%}.report .portfolio .table-wrap{overflow:visible;border:0;scrollbar-gutter:auto}.portfolio table.mobile-portfolio{display:block;min-width:0;width:100%}.mobile-portfolio thead{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.mobile-portfolio tbody{display:block}.mobile-portfolio tbody tr{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 8px;padding:12px 0 16px;border-bottom:1px solid var(--line,#ddd);background:transparent}.portfolio .mobile-portfolio td{display:block;min-width:0;width:auto;padding:8px 0;border:0;white-space:normal;overflow-wrap:anywhere;font-size:14px;text-align:start}.mobile-portfolio td::before{content:attr(data-label);display:block;direction:rtl;text-align:start;font-size:12px;font-weight:400;color:var(--muted,#626870);margin-bottom:4px}.mobile-portfolio td:first-child{grid-column:1/-1;font-size:16px}.mobile-portfolio td:first-child::before{display:none}.mobile-portfolio .spark-cell,.mobile-portfolio td:last-child{grid-column:1/-1}.mobile-portfolio .spark-cell{display:flex;align-items:center;gap:16px}.mobile-portfolio .spark-cell:empty{display:none}.mobile-portfolio .spark{max-width:120px;flex-shrink:0}.mobile-portfolio .pf-score{display:inline-block;white-space:normal}.mobile-portfolio .pf-hz,.mobile-portfolio .pf-risk,.mobile-portfolio .pf-trigger,.mobile-portfolio .pf-alert,.mobile-portfolio .coverage-note{font-size:13px;line-height:1.7}.report .badge{max-width:100%;white-space:normal}.report .stats{min-width:0}}' +
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
      if (reportWindow.parent !== reportWindow && typeof reportWindow.ResizeObserver === 'function') {
        let pendingHeight = false;
        const sendHeight = () => {
          if (pendingHeight) return;
          pendingHeight = true;
          reportWindow.requestAnimationFrame(() => {
            pendingHeight = false;
            reportWindow.parent.postMessage({
              type: 'tase-report-height',
              url: reportWindow.location.href.split('#')[0],
              height: Math.ceil(report.getBoundingClientRect().height + report.offsetTop)
            }, reportWindow.location.protocol === 'file:' ? '*' : reportWindow.location.origin);
          });
        };
        const observer = new reportWindow.ResizeObserver(sendHeight);
        observer.observe(report);
        reportWindow.addEventListener('resize', sendHeight);
        reportWindow.addEventListener('pagehide', event => {
          if (!event.persisted) observer.disconnect();
        });
        reportWindow.addEventListener('pageshow', sendHeight);
        sendHeight();
      }
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
    const mobile = matchMedia('(max-width:760px)');
    let reportHeight = 0;
    const resizeFrame = () => {
      frame.style.height = mobile.matches && reportHeight ? reportHeight + 'px' : '';
    };
    addEventListener('message', event => {
      const data = event.data;
      const expectedOrigin = location.protocol === 'file:' ? 'null' : location.origin;
      if (event.source !== frame.contentWindow || event.origin !== expectedOrigin || !data
        || data.type !== 'tase-report-height' || data.url !== frame.src.split('#')[0]
        || !Number.isFinite(data.height) || data.height < 1 || data.height > 1000000) return;
      reportHeight = data.height;
      frame.dataset.reportHeight = String(reportHeight);
      resizeFrame();
    });
    mobile.addEventListener('change', resizeFrame);
    const compactFrame = () => {
      try { if (frame.contentDocument) compactReport(frame.contentDocument); } catch {}
    };
    frame.addEventListener('load', compactFrame);
    compactFrame();
  }
})();