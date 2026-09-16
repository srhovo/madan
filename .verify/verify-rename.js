const {chromium} = require('playwright-core');
const fs = require('fs');
const html = fs.readFileSync('/workspace/madan/index.html','utf8');
(async()=>{
  const b = await chromium.launch({executablePath:'/usr/bin/chromium', args:['--no-sandbox','--disable-dev-shm-usage']});
  const out=[]; let fail=0;
  for (const vp of [{w:360,h:780,n:'安卓窄屏360'},{w:390,h:844,n:'iPhone390'},{w:430,h:932,n:'ProMax430'}]) {
    const p = await b.newPage({viewport:{width:vp.w,height:vp.h}});
    await p.setContent(html,{waitUntil:'domcontentloaded'});
    await p.waitForTimeout(1500);
    const r = await p.evaluate(()=>{
      const panel=document.getElementById('priceMemPanel');
      panel.classList.remove('hidden','collapsed');
      panel.style.display='block'; panel.style.visibility='hidden';
      let a=panel; while(a){ if(getComputedStyle(a).display==='none') a.style.display='block'; a=a.parentElement; }
      const sel=document.getElementById('pmSettleType');
      const opt=[...sel.options].find(o=>o.value==='round');
      const cs=getComputedStyle(sel); const rect=sel.getBoundingClientRect();
      const cv=document.createElement('canvas'); const ctx=cv.getContext('2d');
      ctx.font=`${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const tw=ctx.measureText(opt.textContent).width;
      const inner=rect.width-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight)-parseFloat(cs.borderLeftWidth)-parseFloat(cs.borderRightWidth);
      // 检测是否被截断：scrollWidth 大于 clientWidth 即为截断
      const truncated = sel.scrollWidth > sel.clientWidth + 1;
      return {text:opt.textContent, textW:+tw.toFixed(1), inner:+inner.toFixed(1), truncated,
              headroom:+(inner-22-tw).toFixed(1)};
    });
    out.push({vp:vp.n,...r});
    if(r.truncated) fail++;
    await p.close();
  }
  await b.close();
  console.table(out);
  console.log(fail===0?'✓ 三个视口均无截断':'✗ 有截断');
  process.exit(fail===0?0:1);
})();
