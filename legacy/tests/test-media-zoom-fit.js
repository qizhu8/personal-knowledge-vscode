const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

test("Fit width settles at the scrollbar height boundary for diagrams and images", async t => {
  const browser = await chromium.launch({
    headless:true, ignoreDefaultArgs:["--hide-scrollbars"], args:["--disable-features=OverlayScrollbar"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:1000, height:800}});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setContent('<style>::-webkit-scrollbar{width:15px;height:15px}body{margin:8px}</style><main id="root" style="width:660px"><div id="diagram"><svg viewBox="0 0 1200 1095"><rect width="1200" height="1095"/></svg></div><div id="picture"><img alt="Tall image"></div></main>');
  await page.addScriptTag({content:fs.readFileSync(path.join(__dirname, "../src/webview/components/media-zoom.js"), "utf8")});
  await page.evaluate(async () => {
    const diagram = document.getElementById("diagram");
    PkmMediaZoom.attach(diagram, diagram.querySelector("svg"), 1200, "Diagram");
    const holder = document.getElementById("picture"), image = holder.querySelector("img");
    image.src = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1095"/>');
    await image.decode();
    PkmMediaZoom.attach(holder, image, 1200, "Picture");
  });
  const sample = () => page.evaluate(async () => {
    const frames = [];
    for (let frame = 0; frame < 24; frame++) {
      await new Promise(requestAnimationFrame);
      frames.push([...document.querySelectorAll(".media-zoom-viewport")].map(viewport => {
        const media = viewport.querySelector("svg,img");
        return {width:viewport.clientWidth, height:viewport.clientHeight,
          mediaWidth:media.getBoundingClientRect().width, scale:viewport.parentElement.querySelector("output").textContent,
          scrollLeft:viewport.scrollLeft, scrollTop:viewport.scrollTop};
      }));
    }
    return frames;
  });
  const settled = async () => {
    const frames = await sample();
    assert.equal(new Set(frames.slice(4).map(frame => JSON.stringify(frame))).size, 1,
      "Fit width must converge, not alternate between scrollbar and no-scrollbar widths");
    for (const media of frames.at(-1)) {
      assert(media.mediaWidth <= media.width, "fitted media stays within the available width");
      assert(media.mediaWidth >= media.width-1, "Fit width uses the available width");
    }
  };
  await settled();
  for (const kind of ["diagram", "image"]) {
    await page.getByRole("button", {name:`Original ${kind} size`, exact:true}).click();
    await page.getByRole("button", {name:`Fit ${kind} to width`, exact:true}).click();
  }
  await settled();
  for (const width of [660.6, 480, 720]) {
    await page.locator("#root").evaluate((root, width) => { root.style.width = `${width}px`; }, width);
    await settled();
  }
  await page.getByRole("button", {name:"View diagram fullscreen", exact:true}).click();
  await settled();
  await page.getByRole("button", {name:"Exit fullscreen", exact:true}).click();
  await settled();
  for (const kind of ["diagram", "image"]) {
    await page.getByRole("button", {name:`Original ${kind} size`, exact:true}).click();
  }
  await page.locator("#root").evaluate(root => { root.style.width = "400px"; });
  const manual = (await sample()).at(-1);
  assert(manual.every(media => media.mediaWidth === 1200 && media.scale === "100%"),
    "container resizing must preserve manual zoom");
  assert.deepEqual(errors, [], "stable fitting produces no ResizeObserver errors");
});
