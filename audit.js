const puppeteer = require('puppeteer-core');
const path = require('path');

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  });
  const page = await browser.newPage();
  const filePath = 'file:///' + path.resolve('index.html').replace(/\\/g, '/');

  const viewports = [
    { name: 'iPhone SE', width: 375, height: 667 },
    { name: 'iPhone 14 Pro', width: 393, height: 852 },
    { name: 'Galaxy S21', width: 360, height: 800 },
    { name: 'iPad Mini', width: 768, height: 1024 },
    { name: 'iPad Pro', width: 1024, height: 1366 },
    { name: 'Laptop', width: 1280, height: 800 },
    { name: 'Desktop', width: 1440, height: 900 },
    { name: 'Wide', width: 1920, height: 1080 },
  ];

  for (const vp of viewports) {
    await page.setViewport({ width: vp.width, height: vp.height });
    await page.goto(filePath, { waitUntil: 'networkidle0' });

    const result = await page.evaluate((vpW) => {
      const issues = [];

      // Helper: relative luminance
      function getLum(r, g, b) {
        const [rs, gs, bs] = [r, g, b].map(c => {
          c = c / 255;
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
      }

      function parseColor(str) {
        const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m) return { r: +m[1], g: +m[2], b: +m[3] };
        return null;
      }

      function contrastRatio(fg, bg) {
        const l1 = getLum(fg.r, fg.g, fg.b);
        const l2 = getLum(bg.r, bg.g, bg.b);
        const lighter = Math.max(l1, l2);
        const darker = Math.min(l1, l2);
        return (lighter + 0.05) / (darker + 0.05);
      }

      // Get effective background color by walking up parents
      function getEffectiveBg(el) {
        let node = el;
        while (node && node !== document.documentElement) {
          const bg = getComputedStyle(node).backgroundColor;
          const parsed = parseColor(bg);
          if (parsed && (parsed.r !== 0 || parsed.g !== 0 || parsed.b !== 0)) {
            // Check if it's not fully transparent
            const alpha = bg.match(/rgba\(\d+,\s*\d+,\s*\d+,\s*([\d.]+)/);
            if (!alpha || parseFloat(alpha[1]) > 0.1) return parsed;
          }
          // If bg is rgb(0,0,0) check if it's actually set or default
          if (parsed && parsed.r === 0 && parsed.g === 0 && parsed.b === 0) {
            const bgProp = getComputedStyle(node).getPropertyValue('background-color');
            if (bgProp !== 'rgba(0, 0, 0, 0)') return parsed;
          }
          node = node.parentElement;
        }
        return { r: 11, g: 10, b: 9 }; // body bg fallback
      }

      const allEls = document.querySelectorAll('*');

      for (const el of allEls) {
        const rect = el.getBoundingClientRect();
        if (rect.height === 0 || rect.width === 0) continue;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        const tag = el.tagName.toLowerCase();
        if (['html','body','script','style','head','meta','link','br','hr','nav','img','svg','filter','rect'].includes(tag)) continue;

        const text = el.textContent.trim();
        if (!text || el.children.length > 0 && el.querySelector('*:not(br):not(span):not(strong):not(em)')) continue;

        const fontSize = parseFloat(style.fontSize);
        const lineHeight = parseFloat(style.lineHeight);
        const cls = el.className ? '.' + el.className.toString().split(' ')[0] : '';
        const id = el.id ? '#' + el.id : '';
        const selector = tag + (id || cls);
        const shortText = text.substring(0, 50);

        // 1. FONT SIZE CHECK
        if (fontSize < 12) {
          issues.push({
            type: 'SMALL_FONT',
            detail: selector + ' = ' + fontSize.toFixed(1) + 'px "' + shortText + '"'
          });
        }

        // 2. LINE HEIGHT CHECK (body text should be >= 1.4)
        if (fontSize >= 14 && text.length > 40 && lineHeight / fontSize < 1.4) {
          issues.push({
            type: 'TIGHT_LINE_HEIGHT',
            detail: selector + ' lineHeight=' + (lineHeight / fontSize).toFixed(2) + ' fontSize=' + fontSize.toFixed(1) + 'px'
          });
        }

        // 3. COLOR CONTRAST CHECK
        if (el.children.length === 0 || (el.children.length === 1 && ['span','strong','em','br'].includes(el.children[0]?.tagName?.toLowerCase()))) {
          const fg = parseColor(style.color);
          const bg = getEffectiveBg(el);
          if (fg && bg) {
            const ratio = contrastRatio(fg, bg);
            const isLargeText = fontSize >= 18.66 || (fontSize >= 14 && style.fontWeight >= 700);
            const minRatio = isLargeText ? 3.0 : 4.5;
            if (ratio < minRatio) {
              issues.push({
                type: 'LOW_CONTRAST',
                detail: selector + ' ratio=' + ratio.toFixed(2) + ' (need ' + minRatio + ') fg=rgb(' + fg.r + ',' + fg.g + ',' + fg.b + ') bg=rgb(' + bg.r + ',' + bg.g + ',' + bg.b + ') "' + shortText.substring(0, 30) + '"'
              });
            }
          }
        }

        // 4. OVERFLOW CHECK
        if (rect.right > vpW + 2) {
          issues.push({
            type: 'OVERFLOW',
            detail: selector + ' right=' + Math.round(rect.right) + 'px (vp=' + vpW + ')'
          });
        }

        // 5. TAP TARGET CHECK (mobile)
        if (vpW <= 480 && (tag === 'a' || tag === 'button')) {
          if (rect.height < 44 && rect.width < 500) {
            issues.push({
              type: 'SMALL_TAP',
              detail: selector + ' h=' + Math.round(rect.height) + 'px w=' + Math.round(rect.width) + 'px "' + shortText.substring(0, 20) + '"'
            });
          }
        }

        // 6. TEXT TRUNCATION CHECK
        if (el.scrollWidth > el.clientWidth + 2 && style.overflow !== 'auto' && style.overflow !== 'scroll' && style.overflowX !== 'auto') {
          issues.push({
            type: 'TEXT_CLIPPED',
            detail: selector + ' scrollW=' + el.scrollWidth + ' clientW=' + el.clientWidth + ' "' + shortText.substring(0, 30) + '"'
          });
        }
      }

      // 7. GRID STACKING CHECK (mobile)
      if (vpW <= 480) {
        const grids = document.querySelectorAll('.bento, .tool-row, .action-row, .tm-row, .flavors, .toc-list');
        for (const grid of grids) {
          const style = getComputedStyle(grid);
          const cols = style.gridTemplateColumns;
          const colCount = cols.split(/\s+/).filter(c => c !== '0px' && c !== '').length;
          if (colCount > 1) {
            issues.push({
              type: 'GRID_NOT_STACKED',
              detail: '.' + grid.className.split(' ')[0] + ' has ' + colCount + ' cols at ' + vpW + 'px (should be 1)'
            });
          }
        }
      }

      return issues;
    }, vp.width);

    console.log('\n========== ' + vp.name + ' (' + vp.width + 'x' + vp.height + ') ==========');
    if (result.length === 0) {
      console.log('  [PASS] No issues');
    } else {
      const grouped = {};
      result.forEach(r => {
        if (!grouped[r.type]) grouped[r.type] = [];
        grouped[r.type].push(r.detail);
      });
      for (const [type, items] of Object.entries(grouped)) {
        console.log('\n  [' + type + '] (' + items.length + ')');
        // Deduplicate similar
        const unique = [...new Set(items)];
        unique.slice(0, 8).forEach(i => console.log('    ' + i));
        if (unique.length > 8) console.log('    ... and ' + (unique.length - 8) + ' more');
      }
    }
  }

  await browser.close();
})();
