(function () {
  'use strict';

  // PDF.js worker (run in browser, no server)
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  var pdfDoc = null;
  var numPages = 0;
  var currentPageNum = 1;
  var BASE_SCALE = 1.8;      // Scale cơ sở (logical)
  var DPR = window.devicePixelRatio || 1; // Hệ số pixel màn hình (2 = Retina)
  var scale = BASE_SCALE * DPR;  // Scale thực render vào canvas để nét trên mọi màn hình
  var exportScale = 4;       // Khi lưu PDF: render độ phân giải cao (4x) để file đẹp
  var pdfCanvas = document.getElementById('pdfCanvas');
  var fabricCanvasEl = document.getElementById('fabricCanvas');
  var canvasWrap = document.getElementById('canvasWrap');
  var hint = document.getElementById('hint');
  var pageInfo = document.getElementById('pageInfo');
  var pageNumInput = document.getElementById('pageNum');
  var strokeColor = document.getElementById('strokeColor');
  var strokeWidth = document.getElementById('strokeWidth');
  var strokeValue = document.getElementById('strokeValue');

  // Bản gốc PDF (ArrayBuffer) để lưu ra giữ nguyên chất lượng, không raster lại
  var pdfArrayBuffer = null;
  // Per-page annotation state (Fabric JSON)
  var annotationsByPage = {};
  // Per-page undo history (each entry = canvas state before an action)
  var undoHistory = {};
  var MAX_UNDO = 30;
  var skipNextPush = false;
  var hasPushedForThisModify = false;

  var fabricCanvas = null;

  var currentShapeType = null;
  var currentShape = null;
  var shapeStartPt = null;

  function clearToolListeners() {
    if (!fabricCanvas) return;
    fabricCanvas.off('mouse:down', textMouseDownHandler);
    fabricCanvas.off('mouse:down', shapeMouseDownHandler);
    fabricCanvas.off('mouse:move', shapeMouseMoveHandler);
    fabricCanvas.off('mouse:up', shapeMouseUpHandler);
    currentShape = null;
  }

  function textMouseDownHandler(ev) {
    pushUndoState();
    var pt = fabricCanvas.getPointer(ev.e);
    var text = new fabric.IText('Text', {
      left: pt.x,
      top: pt.y,
      fontFamily: 'Arial',
      fontSize: 18,
      fill: strokeColor.value,
    });
    fabricCanvas.add(text);
    clearToolListeners();
    setTool('select');
    document.querySelector('.btn-tool[data-tool="select"]').classList.add('active');
    document.querySelectorAll('.btn-tool').forEach(function (b) {
      if (b.dataset.tool !== 'select') b.classList.remove('active');
    });
  }

  function shapeMouseMoveHandler(ev) {
    if (!currentShape || !shapeStartPt) return;
    var p = fabricCanvas.getPointer(ev.e);
    var pt = shapeStartPt;
    var type = currentShapeType;
    var isCover = type === 'cover';
    var pad = isCover ? 8 : 0;
    if (type === 'ellipse') {
      currentShape.set({ rx: Math.abs(p.x - pt.x) / 2, ry: Math.abs(p.y - pt.y) / 2 });
      currentShape.set({ left: Math.min(pt.x, p.x), top: Math.min(pt.y, p.y) });
    } else {
      var w = Math.abs(p.x - pt.x);
      var h = Math.abs(p.y - pt.y);
      var left = Math.min(pt.x, p.x);
      var top = Math.min(pt.y, p.y);
      if (isCover) {
        left -= pad;
        top -= pad;
        w += pad * 2;
        h += pad * 2;
        left = Math.floor(left);
        top = Math.floor(top);
        w = Math.ceil(w);
        h = Math.ceil(h);
      }
      currentShape.set({ width: w, height: h, left: left, top: top });
    }
    fabricCanvas.renderAll();
  }

  function shapeMouseUpHandler() {
    fabricCanvas.off('mouse:move', shapeMouseMoveHandler);
    fabricCanvas.off('mouse:up', shapeMouseUpHandler);
    currentShape = null;
    shapeStartPt = null;
    setTool('select');
    document.querySelector('.btn-tool[data-tool="select"]').classList.add('active');
    document.querySelectorAll('.btn-tool').forEach(function (b) {
      if (b.dataset.tool !== 'select') b.classList.remove('active');
    });
  }

  function shapeMouseDownHandler(ev) {
    pushUndoState();
    var pt = fabricCanvas.getPointer(ev.e);
    shapeStartPt = pt;
    var type = currentShapeType;
    var isHighlight = type === 'highlight';
    var isCover = type === 'cover';
    var opts = {
      left: pt.x,
      top: pt.y,
      width: 0,
      height: 0,
      fill: isCover ? '#ffffff' : (isHighlight ? 'rgba(255,255,0,0.35)' : 'transparent'),
      stroke: isCover ? '#ffffff' : strokeColor.value,
      strokeWidth: isCover ? 2 : (isHighlight ? 0 : parseInt(strokeWidth.value, 10)),
    };
    if (type === 'ellipse') {
      opts.rx = 0;
      opts.ry = 0;
    }
    currentShape = type === 'ellipse'
      ? new fabric.Ellipse(opts)
      : new fabric.Rect(opts);
    if (isCover) {
      currentShape.set({
        hasBorders: false,
        hasControls: false,
        borderColor: 'transparent',
        coverRect: true,
      });
    }
    fabricCanvas.add(currentShape);
    fabricCanvas.on('mouse:move', shapeMouseMoveHandler);
    fabricCanvas.on('mouse:up', shapeMouseUpHandler);
  }

  function initFabric() {
    fabricCanvas = new fabric.Canvas('fabricCanvas', {
      selection: true,
      preserveObjectStacking: true,
    });
    // Fabric.js replaces the canvas with a wrapper div; position it on top of the PDF canvas so it receives clicks
    var wrapper = fabricCanvas.wrapperEl || fabricCanvas.lowerCanvasEl.parentNode;
    if (wrapper) {
      wrapper.style.position = 'absolute';
      wrapper.style.left = '0';
      wrapper.style.top = '0';
      wrapper.style.pointerEvents = 'auto';
      wrapper.style.zIndex = '1';
    }
    fabricCanvas.freeDrawingBrush.width = parseInt(strokeWidth.value, 10);
    fabricCanvas.freeDrawingBrush.color = strokeColor.value;

    strokeWidth.addEventListener('input', function () {
      var v = parseInt(strokeWidth.value, 10);
      strokeValue.textContent = v;
      if (fabricCanvas) {
        fabricCanvas.freeDrawingBrush.width = v;
      }
    });
    strokeColor.addEventListener('input', function () {
      if (fabricCanvas) {
        fabricCanvas.freeDrawingBrush.color = strokeColor.value;
        fabricCanvas.getContext('2d').strokeStyle = strokeColor.value;
      }
    });

    // Tool handlers
    document.querySelectorAll('.btn-tool').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.btn-tool').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        setTool(btn.dataset.tool);
      });
    });

    document.getElementById('clearPage').addEventListener('click', clearCurrentPageAnnotations);
    document.getElementById('savePdf').addEventListener('click', savePdf);
    document.getElementById('deleteSelected').addEventListener('click', deleteSelected);

    // Undo (Ctrl+Z) and push state before Delete/Backspace
    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey && e.key === 'z') {
        e.preventDefault();
        undo();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        var active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
        var obj = fabricCanvas.getActiveObject();
        if (obj && !obj.isEditing) pushUndoState();
      }
    });

    // Save state before actions; catch object:modified (move/scale) and path:created (draw)
    fabricCanvas.on('object:moving', function () {
      if (!hasPushedForThisModify) {
        pushUndoState();
        hasPushedForThisModify = true;
      }
    });
    fabricCanvas.on('object:scaling', function () {
      if (!hasPushedForThisModify) {
        pushUndoState();
        hasPushedForThisModify = true;
      }
    });
    fabricCanvas.on('object:modified', function () {
      hasPushedForThisModify = false;
    });
    fabricCanvas.on('path:created', function () {
      var json = fabricCanvas.toJSON(CUSTOM_PROPS);
      if (json.objects && json.objects.length > 0) {
        json.objects = json.objects.slice(0, -1);
        pushCustomState(json);
      }
    });
  }

  function pushUndoState() {
    if (skipNextPush || !fabricCanvas) return;
    var json = fabricCanvas.toJSON(CUSTOM_PROPS);
    undoHistory[currentPageNum] = undoHistory[currentPageNum] || [];
    var arr = undoHistory[currentPageNum];
    arr.push(json);
    if (arr.length > MAX_UNDO) arr.shift();
  }

  function pushCustomState(json) {
    if (skipNextPush || !fabricCanvas) return;
    undoHistory[currentPageNum] = undoHistory[currentPageNum] || [];
    var arr = undoHistory[currentPageNum];
    arr.push(json);
    if (arr.length > MAX_UNDO) arr.shift();
  }

  function undo() {
    var arr = undoHistory[currentPageNum];
    if (!arr || arr.length === 0) return;
    var state = arr.pop();
    skipNextPush = true;
    fabricCanvas.loadFromJSON(state, function () {
      fabricCanvas.renderAll();
      annotationsByPage[currentPageNum] = state;
      setTimeout(function () { skipNextPush = false; }, 100);
    });
  }

  function setTool(tool) {
    if (!fabricCanvas) return;
    clearToolListeners();
    fabricCanvas.isDrawingMode = false;
    fabricCanvas.selection = true;
    fabricCanvas.defaultCursor = 'default';
    fabricCanvas.hoverCursor = 'move';

    switch (tool) {
      case 'select':
        break;
      case 'text':
        fabricCanvas.selection = false;
        fabricCanvas.defaultCursor = 'text';
        fabricCanvas.on('mouse:down', textMouseDownHandler);
        break;
      case 'draw':
        fabricCanvas.isDrawingMode = true;
        fabricCanvas.freeDrawingBrush.color = strokeColor.value;
        fabricCanvas.freeDrawingBrush.width = parseInt(strokeWidth.value, 10);
        break;
      case 'rect':
        fabricCanvas.selection = false;
        currentShapeType = 'rect';
        fabricCanvas.on('mouse:down', shapeMouseDownHandler);
        break;
      case 'ellipse':
        fabricCanvas.selection = false;
        currentShapeType = 'ellipse';
        fabricCanvas.on('mouse:down', shapeMouseDownHandler);
        break;
      case 'highlight':
        fabricCanvas.selection = false;
        currentShapeType = 'highlight';
        fabricCanvas.on('mouse:down', shapeMouseDownHandler);
        break;
      case 'cover':
        fabricCanvas.selection = false;
        currentShapeType = 'cover';
        fabricCanvas.on('mouse:down', shapeMouseDownHandler);
        break;
      case 'sign':
        fabricCanvas.isDrawingMode = true;
        fabricCanvas.freeDrawingBrush.color = '#000';
        fabricCanvas.freeDrawingBrush.width = 2;
        break;
    }
  }

  var CUSTOM_PROPS = ['coverRect'];

  function saveCurrentPageAnnotations() {
    if (!fabricCanvas) return;
    annotationsByPage[currentPageNum] = fabricCanvas.toJSON(CUSTOM_PROPS);
  }

  function loadPageAnnotations() {
    if (!fabricCanvas) return;
    var data = annotationsByPage[currentPageNum];
    if (data) {
      fabricCanvas.loadFromJSON(data, function () {
        fabricCanvas.renderAll();
      });
    } else {
      fabricCanvas.clear();
      fabricCanvas.renderAll();
    }
  }

  function clearCurrentPageAnnotations() {
    if (!fabricCanvas) return;
    fabricCanvas.clear();
    delete annotationsByPage[currentPageNum];
    undoHistory[currentPageNum] = [];
    fabricCanvas.renderAll();
  }

  /** Xóa đối tượng đang chọn (chữ, hình, ảnh đã thêm hoặc ô che trắng). */
  function deleteSelected() {
    if (!fabricCanvas) return;
    var active = fabricCanvas.getActiveObject();
    if (!active) {
      alert('Chọn một đối tượng trước (dùng công cụ Select ↖, click vào chữ/hình rồi bấm Xóa chọn hoặc phím Delete).');
      return;
    }
    pushUndoState();
    var toRemove = (active.type === 'activeSelection' || active.type === 'group') ? active.getObjects() : [active];
    toRemove.forEach(function (obj) {
      fabricCanvas.remove(obj);
    });
    fabricCanvas.discardActiveObject();
    fabricCanvas.renderAll();
  }

  /** Lấy bounding box (top, left, width, height) của một hoặc nhiều object (trong tọa độ canvas). */

  function renderPdfPage(pageNum) {
    if (!pdfDoc) return;
    pdfDoc.getPage(pageNum).then(function (page) {
      // Render ở scale thực (BASE_SCALE * DPR) để nét trên màn hình HiDPI/Retina
      var vp = page.getViewport({ scale: scale });
      var w = vp.width;
      var h = vp.height;
      // Kích thước CSS hiển thị = kích thước logical (không nhân DPR)
      var cssW = Math.round(w / DPR);
      var cssH = Math.round(h / DPR);

      pdfCanvas.width = w;
      pdfCanvas.height = h;
      pdfCanvas.style.width = cssW + 'px';
      pdfCanvas.style.height = cssH + 'px';

      fabricCanvas.setDimensions({ width: w, height: h });
      var wrapper = fabricCanvas.wrapperEl || fabricCanvas.lowerCanvasEl.parentNode;
      if (wrapper) {
        wrapper.style.width = cssW + 'px';
        wrapper.style.height = cssH + 'px';
      }
      // Điều chỉnh Fabric canvas CSS để khớp kích thước hiển thị
      var lowerEl = fabricCanvas.lowerCanvasEl;
      var upperEl = fabricCanvas.upperCanvasEl;
      [lowerEl, upperEl].forEach(function (el) {
        if (el) {
          el.style.width = cssW + 'px';
          el.style.height = cssH + 'px';
        }
      });
      fabricCanvas.renderAll();

      var ctx = pdfCanvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      page.render({
        canvasContext: ctx,
        viewport: vp,
      }).promise.then(function () {
        loadPageAnnotations();
      });
    });
  }

  function goToPage(n) {
    n = Math.max(1, Math.min(n, numPages));
    if (n === currentPageNum) return;
    saveCurrentPageAnnotations();
    currentPageNum = n;
    pageNumInput.value = n;
    pageInfo.textContent = 'Page ' + n + ' / ' + numPages;
    renderPdfPage(currentPageNum);
  }

  function loadPdf(arrayBuffer) {
    saveCurrentPageAnnotations();
    // Clone buffer: PDF.js có thể "transfer" buffer khi load → detached, không dùng lại được. Giữ bản copy để lúc Save dùng.
    pdfArrayBuffer = arrayBuffer.slice(0);
    annotationsByPage = {};
    undoHistory = {};

    pdfjsLib.getDocument({ data: arrayBuffer }).promise.then(function (doc) {
      pdfDoc = doc;
      numPages = doc.numPages;
      currentPageNum = 1;
      pageNumInput.value = 1;
      pageNumInput.max = numPages;
      pageInfo.textContent = 'Page 1 / ' + numPages;
      hint.classList.add('hidden');
      canvasWrap.classList.remove('hidden');
      renderPdfPage(1);
    }).catch(function (err) {
      console.error(err);
      alert('Could not load PDF: ' + err.message);
    });
  }

  document.getElementById('fileInput').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (ev) {
      loadPdf(ev.target.result);
    };
    reader.readAsArrayBuffer(file);
  });

  document.getElementById('prevPage').addEventListener('click', function () {
    goToPage(currentPageNum - 1);
  });
  document.getElementById('nextPage').addEventListener('click', function () {
    goToPage(currentPageNum + 1);
  });
  pageNumInput.addEventListener('change', function () {
    goToPage(parseInt(pageNumInput.value, 10) || 1);
  });

  /** Tách annotation thành 3 nhóm: coverRects (vẽ vector trắng), textObjects (vẽ vector text), restJson (vẽ PNG). */
  function splitAnnotations(json) {
    if (!json || !json.objects || !json.objects.length) {
      return { coverRects: [], textObjects: [], restJson: null };
    }
    var coverRects = [];
    var textObjects = [];
    var restObjects = [];
    json.objects.forEach(function (obj) {
      if (obj.coverRect === true) {
        coverRects.push(obj);
      } else if (obj.type === 'i-text' || obj.type === 'text') {
        textObjects.push(obj);
      } else {
        restObjects.push(obj);
      }
    });
    var restJson = restObjects.length
      ? { version: json.version, objects: restObjects }
      : null;
    return { coverRects: coverRects, textObjects: textObjects, restJson: restJson };
  }

  /** Render lớp annotation ra PNG — loại bỏ cover rects và text (cả hai được vẽ vector riêng). */
  function renderAnnotationLayerToDataUrl(pageNum) {
    return new Promise(function (resolve, reject) {
      pdfDoc.getPage(pageNum).then(function (page) {
        var vp = page.getViewport({ scale: scale });
        var w = vp.width;
        var h = vp.height;
        function renderJson(data) {
          if (!data) { resolve(null); return; }
          var tempCanvas = document.createElement('canvas');
          tempCanvas.width = w;
          tempCanvas.height = h;
          var fc = new fabric.Canvas(tempCanvas, { width: w, height: h });
          fc.loadFromJSON(data, function () {
            fc.renderAll();
            var el = fc.lowerCanvasEl;
            resolve(el ? el.toDataURL('image/png') : null);
          });
        }
        var rawData = pageNum === currentPageNum && fabricCanvas
          ? fabricCanvas.toJSON(CUSTOM_PROPS)
          : (annotationsByPage[pageNum] || null);
        if (!rawData) { resolve(null); return; }
        var split = splitAnnotations(rawData);
        renderJson(split.restJson);
      }).catch(reject);
    });
  }

  /** Chuyển màu hex (#rrggbb) hoặc rgb/rgba sang RGB pdf-lib (0–1). */
  function hexToRgb(hex) {
    if (!hex || typeof hex !== 'string') return { red: 0, green: 0, blue: 0 };
    var m = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
    if (m) {
      return {
        red: parseInt(m[1], 16) / 255,
        green: parseInt(m[2], 16) / 255,
        blue: parseInt(m[3], 16) / 255,
      };
    }
    var rgb = hex.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (rgb) {
      return {
        red: Math.min(1, parseInt(rgb[1], 10) / 255),
        green: Math.min(1, parseInt(rgb[2], 10) / 255),
        blue: Math.min(1, parseInt(rgb[3], 10) / 255),
      };
    }
    return { red: 0, green: 0, blue: 0 };
  }

  /** Vẽ cover rects (hình chữ nhật trắng) lên trang PDF bằng pdf-lib — không qua PNG, không có viền. */
  function drawCoverRectsAsVector(pdfPage, coverRects, displayW, displayH) {
    if (!coverRects || coverRects.length === 0) return;
    var pw = pdfPage.getWidth();
    var ph = pdfPage.getHeight();
    var scaleX = pw / displayW;
    var scaleY = ph / displayH;
    var rgbFn = typeof PDFLib !== 'undefined' && PDFLib.rgb ? PDFLib.rgb : null;
    if (!rgbFn) return;
    var white = rgbFn(1, 1, 1);
    coverRects.forEach(function (obj) {
      var left = Number(obj.left) || 0;
      var top = Number(obj.top) || 0;
      var width = Number(obj.width) || 0;
      var height = Number(obj.height) || 0;
      var pdfX = left * scaleX;
      var pdfW = width * scaleX;
      var pdfH = height * scaleY;
      // PDF tọa độ gốc dưới-trái; Fabric gốc trên-trái
      var pdfY = ph - (top + height) * scaleY;
      pdfPage.drawRectangle({
        x: pdfX,
        y: pdfY,
        width: pdfW,
        height: pdfH,
        color: white,
        borderWidth: 0,
      });
    });
  }

  /** Vẽ các text từ Fabric JSON lên trang PDF (vector) bằng pdf-lib. */
  function drawTextObjectsAsVector(pdfPage, font, textObjects, displayW, displayH) {
    if (!textObjects || textObjects.length === 0 || !font) return;
    var pw = pdfPage.getWidth();
    var ph = pdfPage.getHeight();
    var scaleX = pw / displayW;
    var scaleY = ph / displayH;
    var rgbFn = typeof PDFLib !== 'undefined' && PDFLib.rgb ? PDFLib.rgb : null;
    if (!rgbFn) return;
    textObjects.forEach(function (obj) {
      var text = obj.text != null ? String(obj.text) : '';
      if (!text) return;
      var left = Number(obj.left) || 0;
      var top = Number(obj.top) || 0;
      var fontSize = Number(obj.fontSize) || 18;
      var fill = obj.fill || '#000000';
      var pdfX = left * scaleX;
      var pdfY = ph - (top + fontSize * 0.85) * scaleY;
      var pdfSize = fontSize * scaleY;
      if (pdfSize <= 0) return;
      var c = hexToRgb(fill);
      try {
        pdfPage.drawText(text, {
          x: pdfX,
          y: pdfY,
          size: pdfSize,
          font: font,
          color: rgbFn(c.red, c.green, c.blue),
        });
      } catch (e) {
        console.warn('drawText skip', e);
      }
    });
  }

  function compositePageToImage(pageNum) {
    return new Promise(function (resolve, reject) {
      pdfDoc.getPage(pageNum).then(function (page) {
        // Render PDF ở độ phân giải cao (exportScale) để file lưu ra sắc nét
        var vpExport = page.getViewport({ scale: exportScale });
        var w = vpExport.width;
        var h = vpExport.height;
        var displayVp = page.getViewport({ scale: scale });
        var displayW = displayVp.width;
        var displayH = displayVp.height;

        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        page.render({
          canvasContext: ctx,
          viewport: vpExport,
        }).promise.then(function () {
          function drawFabricOverlay(fabricCanvasOrEl) {
            var el = fabricCanvasOrEl.lowerCanvasEl || fabricCanvasOrEl;
            // Vẽ lớp annotation từ kích thước hiển thị lên kích thước xuất (scale up) để khớp chất lượng
            ctx.drawImage(el, 0, 0, displayW, displayH, 0, 0, w, h);
            resolve(canvas.toDataURL('image/png'));
          }
          if (pageNum === currentPageNum && fabricCanvas) {
            drawFabricOverlay(fabricCanvas);
          } else if (annotationsByPage[pageNum]) {
            var tempCanvas = document.createElement('canvas');
            tempCanvas.width = displayW;
            tempCanvas.height = displayH;
            var fc = new fabric.Canvas(tempCanvas, { width: displayW, height: displayH });
            fc.loadFromJSON(annotationsByPage[pageNum], function () {
              fc.renderAll();
              drawFabricOverlay(fc);
            });
          } else {
            resolve(canvas.toDataURL('image/png'));
          }
        });
      }).catch(reject);
    });
  }

  function dataUrlToUint8Array(dataUrl) {
    var binary = atob(dataUrl.split(',')[1]);
    var len = binary.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function savePdf() {
    if (!pdfDoc) {
      alert('Open a PDF first.');
      return;
    }
    saveCurrentPageAnnotations();
    var { PDFDocument } = PDFLib;

    function doSaveWithOriginalPdf() {
      return PDFDocument.load(pdfArrayBuffer).then(function (doc) {
        var StandardFonts = typeof PDFLib !== 'undefined' && PDFLib.StandardFonts ? PDFLib.StandardFonts : null;
        var font = StandardFonts ? doc.embedStandardFont(StandardFonts.Helvetica) : null;
        var chain = Promise.resolve();
        for (var i = 0; i < numPages; i++) {
          (function (pageIndex) {
            var pageNum = pageIndex + 1;
            chain = chain.then(function () {
              return pdfDoc.getPage(pageNum).then(function (pdfJsPage) {
                var vp = pdfJsPage.getViewport({ scale: scale });
                var displayW = vp.width;
                var displayH = vp.height;
                var rawData = pageNum === currentPageNum && fabricCanvas
                  ? fabricCanvas.toJSON(CUSTOM_PROPS)
                  : (annotationsByPage[pageNum] || null);
                var split = splitAnnotations(rawData);
                var page = doc.getPage(pageIndex);
                // 1. Vẽ cover rects trắng bằng vector (không có viền)
                drawCoverRectsAsVector(page, split.coverRects, displayW, displayH);
                // 2. Render phần còn lại (draw, rect, ellipse, highlight) ra PNG và phủ lên
                return renderAnnotationLayerToDataUrl(pageNum).then(function (dataUrl) {
                  if (dataUrl) {
                    var imgBytes = dataUrlToUint8Array(dataUrl);
                    return doc.embedPng(imgBytes).then(function (img) {
                      page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
                    });
                  }
                }).then(function () {
                  // 3. Vẽ text bằng vector
                  if (font && split.textObjects.length > 0) {
                    drawTextObjectsAsVector(page, font, split.textObjects, displayW, displayH);
                  }
                });
              });
            });
          })(i);
        }
        return chain.then(function () {
          return doc.save();
        });
      });
    }

    function doSaveRasterized() {
      return PDFDocument.create().then(function (newDoc) {
        var chain = Promise.resolve();
        for (var p = 1; p <= numPages; p++) {
          (function (pageNum) {
            chain = chain.then(function () {
              return compositePageToImage(pageNum);
            }).then(function (dataUrl) {
              var imgBytes = dataUrlToUint8Array(dataUrl);
              return newDoc.embedPng(imgBytes).then(function (img) {
                var page = newDoc.addPage([img.width, img.height]);
                page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
              });
            });
          })(p);
        }
        return chain.then(function () {
          return newDoc.save();
        });
      });
    }

    var savePromise = pdfArrayBuffer ? doSaveWithOriginalPdf() : doSaveRasterized();
    savePromise.then(function (bytes) {
      var blob = new Blob([bytes], { type: 'application/pdf' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'pdfix-edited.pdf';
      a.click();
      URL.revokeObjectURL(a.href);
    }).catch(function (err) {
      console.error(err);
      alert('Save failed: ' + err.message);
    });
  }

  initFabric();
})();
