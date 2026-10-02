(() => {
  const SORT_BUTTON = 'table-sort-button';

  function headerColumn(header) {
    const rows = [...header.closest('thead').rows];
    const occupied = [];
    for (const row of rows) {
      let column = 0;
      for (const cell of row.cells) {
        while (occupied[column]) column++;
        if (cell === header) return column;
        const colspan = cell.colSpan || 1;
        const rowspan = cell.rowSpan || 1;
        for (let offset = 0; offset < colspan; offset++) occupied[column + offset] = rowspan;
        column += colspan;
      }
      for (let index = 0; index < occupied.length; index++) {
        if (occupied[index]) occupied[index]--;
      }
    }
    return -1;
  }

  function prepareHeaders(root = document) {
    root.querySelectorAll('table thead th').forEach((header) => {
      if (header.colSpan > 1 || header.querySelector(`.${SORT_BUTTON}`)) return;

      const label = document.createElement('span');
      while (header.firstChild) label.append(header.firstChild);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = SORT_BUTTON;
      button.title = 'Sort ascending';
      button.setAttribute('aria-label', `Sort ${label.textContent.trim()} ascending`);
      button.dataset.column = String(headerColumn(header));

      const arrow = document.createElement('span');
      arrow.className = 'table-sort-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '↕';
      button.append(label, arrow);
      header.append(button);
    });
  }

  function cellForColumn(row, targetColumn) {
    let column = 0;
    for (const cell of row.cells) {
      const colspan = cell.colSpan || 1;
      if (targetColumn >= column && targetColumn < column + colspan) return cell;
      column += colspan;
    }
    return null;
  }

  function numericValue(text) {
    const cleaned = text.replace(/[₹,%\s,]/g, '');
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
    const value = Number(cleaned);
    return Number.isFinite(value) ? value : null;
  }

  function sortTable(button) {
    const table = button.closest('table');
    const header = button.closest('th');
    const body = table?.tBodies[0];
    if (!body || !header) return;

    const column = Number(button.dataset.column);
    if (column < 0) return;
    const direction = header.dataset.sortDirection === 'asc' ? 'desc' : 'asc';
    const heading = button.querySelector('span')?.textContent.trim() || '';
    table.querySelectorAll('thead th').forEach((cell) => {
      delete cell.dataset.sortDirection;
      cell.removeAttribute('aria-sort');
      const arrow = cell.querySelector('.table-sort-arrow');
      if (arrow) arrow.textContent = '↕';
    });
    header.dataset.sortDirection = direction;
    header.setAttribute('aria-sort', direction === 'asc' ? 'ascending' : 'descending');
    button.title = `Sort ${direction === 'asc' ? 'descending' : 'ascending'}`;
    button.setAttribute('aria-label', `Sort ${header.textContent.trim()} ${direction === 'asc' ? 'descending' : 'ascending'}`);
    button.querySelector('.table-sort-arrow').textContent = direction === 'asc' ? '↑' : '↓';

    const rows = [...body.rows];
    if (rows.some((row) => [...row.cells].some((cell) => cell.colSpan > 1))) return;
    rows.sort((left, right) => {
      let leftText = cellForColumn(left, column)?.innerText.trim() || '';
      let rightText = cellForColumn(right, column)?.innerText.trim() || '';
      if (heading.toLowerCase() === 'scheme name') {
        leftText = leftText.replace(/^\d+\.\s*/, '');
        rightText = rightText.replace(/^\d+\.\s*/, '');
      }
      if (!leftText || leftText === '—') return rightText && rightText !== '—' ? 1 : 0;
      if (!rightText || rightText === '—') return -1;
      const leftNumber = numericValue(leftText);
      const rightNumber = numericValue(rightText);
      const comparison = leftNumber !== null && rightNumber !== null
        ? leftNumber - rightNumber
        : leftText.localeCompare(rightText, undefined, { numeric: true, sensitivity: 'base' });
      return direction === 'asc' ? comparison : -comparison;
    });
    rows.forEach((row) => body.append(row));
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest(`.${SORT_BUTTON}`);
    if (button) sortTable(button);
  });

  prepareHeaders();
  new MutationObserver((mutations) => {
    mutations.forEach(({ target }) => {
      if (target.nodeType === Node.ELEMENT_NODE) prepareHeaders(target.closest('table') || target);
    });
  }).observe(document.body, { childList: true, subtree: true });
})();