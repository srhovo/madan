const {chromium} = require('playwright-core');
const fs = require('fs');
const html = fs.readFileSync('/workspace/madan/index.html','utf8');

(async()=>{
  const b = await chromium.launch({executablePath:'/usr/bin/chromium', args:['--no-sandbox','--disable-dev-shm-usage']});
  const out = [];
  for (const vp of [{w:360,h:780,n:'安卓窄屏 360'},{w:390,h:844,n:'iPhone 竖屏 390'},{w:430,h:932,n:'iPhone ProMax 430'},{w:768,h:1024,n:'平板竖屏 768'}]) {
    const p = await b.newPage({viewport:{width:vp.w,height:vp.h}});
    await p.setContent(html, {waitUntil:'domcontentloaded'});
    await p.waitForTimeout(1500);
    const r = await p.evaluate(()=>{
      // 强制显示价格库面板（绕过折叠动画，只测几何）
      const panel = document.getElementById('priceMemPanel');
      if(!panel) return {err:'no panel'};
      panel.classList.remove('hidden','collapsed');
      panel.style.display='block'; panel.style.visibility='hidden';
      let a = panel; while(a){ if(getComputedStyle(a).display==='none') a.style.display='block'; a=a.parentElement; }
      const sel = document.getElementById('pmSettleType');
      if(!sel) return {err:'no select'};
      const cs = getComputedStyle(sel);
      const rect = sel.getBoundingClientRect();
      const cv=document.createElement('canvas'); const ctx=cv.getContext('2d');
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const w = t => ctx.measureText(t).width;
      const inner = rect.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
      const ARROW = 22; // 原生下拉箭头预留
      return {
        selWidth:+rect.width.toFixed(1), inner:+inner.toFixed(1), fontSize:cs.fontSize,
        wOld:+w('局数单价').toFixed(1), wNew:+w('局数/个数 单价').toFixed(1),
        wNewShort:+w('局数/个数').toFixed(1),
        fitsOld:+(w('局数单价')+ARROW <= inner), fitsNew:+(w('局数/个数 单价')+ARROW <= inner)
      };
    });
    out.push({vp:vp.n, ...r});
    await p.close();
  }
  await b.close();
  console.table(out);
})();
