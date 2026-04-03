/**
 * TextRenderer — lays out a paragraph into word-particles using pretext,
 * then draws each word on a canvas at its (physics-displaced) position.
 */
import { prepareWithSegments, layoutWithLines } from 'https://esm.sh/@chenglou/pretext';

export class TextRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {string} text       Full paragraph text
   * @param {string} font       CSS font string, e.g. '18px Georgia, serif'
   * @param {number} lineHeight Pixel line height, e.g. 32
   */
  constructor(canvas, text, font, lineHeight) {
    this._canvas = canvas;
    this._ctx = canvas.getContext('2d');
    this._text = text;
    this._font = font;
    this._lineHeight = lineHeight;
    this._wordParticles = [];
    this._totalHeight = 0;
  }

  // ─── Public getters ───────────────────────────────────────────────────────

  /** Array of {id, word, restX, restY, width} — the rest layout. */
  get wordParticles() {
    return this._wordParticles;
  }

  /** Total pixel height of the laid-out text block. */
  get totalHeight() {
    return this._totalHeight;
  }

  // ─── Layout ───────────────────────────────────────────────────────────────

  /**
   * Run pretext layout and compute rest positions for every word.
   * Must be called (and awaited) before render().
   */
  async prepare() {
    const ctx = this._ctx;
    const canvas = this._canvas;

    // Set font on context so measureText() uses the right metrics.
    ctx.font = this._font;

    // Use pretext to segment the text and compute line breaks at canvas width.
    const maxWidth = canvas.width - 80; // 40px horizontal padding each side
    const prepared = prepareWithSegments(this._text, this._font);
    const { lines, height } = layoutWithLines(prepared, maxWidth, this._lineHeight);

    this._totalHeight = height;
    this._wordParticles = [];

    let id = 0;

    lines.forEach((line, lineIndex) => {
      // Vertical center of this line
      const restY = lineIndex * this._lineHeight + this._lineHeight / 2;

      // Pretext gives us line.width — use it to center the line.
      const lineStartX = (canvas.width - line.width) / 2;

      // Split line text into words, preserving trailing spaces so widths sum correctly.
      const rawWords = line.text.split(' ');
      let cursorX = lineStartX;

      rawWords.forEach((word, wi) => {
        if (!word) return; // skip empty strings from leading/trailing spaces

        // Add a trailing space to all but the last word so widths match the
        // rendered line width pretext computed.
        const wordWithSpace = wi < rawWords.length - 1 ? word + ' ' : word;
        const wordWidth = ctx.measureText(wordWithSpace).width;

        this._wordParticles.push({
          id,
          word: wordWithSpace, // draw with trailing space to maintain natural spacing
          restX: cursorX,
          restY,
          width: wordWidth,
        });

        cursorX += wordWidth;
        id++;
      });
    });
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  /**
   * Clear the canvas and draw all words at their current physics positions.
   *
   * @param {Array<{id:number, x:number, y:number}>} currentPositions — from RopePhysics
   * @param {'idle'|'dragging'|'returning'} state
   * @param {number} dragDistance
   */
  render(currentPositions, state, dragDistance) {
    const ctx = this._ctx;
    const canvas = this._canvas;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (state === 'idle') {
      // Fast path: draw all words at rest positions, no displacement math.
      ctx.font = this._font;
      ctx.fillStyle = 'rgb(30, 25, 20)';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      for (const wp of this._wordParticles) {
        ctx.fillText(wp.word, wp.restX, wp.restY);
      }
      return;
    }

    // Build a position lookup by id for quick access.
    const posMap = {};
    for (const pos of currentPositions) {
      posMap[pos.id] = pos;
    }

    // Compute per-word displacement from rest.
    const displacements = this._wordParticles.map(wp => {
      const cur = posMap[wp.id] || { x: wp.restX, y: wp.restY };
      const dx = cur.x - wp.restX;
      const dy = cur.y - wp.restY;
      return { x: cur.x, y: cur.y, dx, dy, disp: Math.sqrt(dx * dx + dy * dy) };
    });

    // ── Draw rope line through displaced words ────────────────────────────
    // Collect words that have moved more than 2px and draw a smooth bezier rope.
    const displaced = [];
    for (let i = 0; i < this._wordParticles.length; i++) {
      if (displacements[i].disp > 2) {
        displaced.push({ wp: this._wordParticles[i], d: displacements[i] });
      }
    }

    if (displaced.length >= 2) {
      ctx.save();
      ctx.strokeStyle = 'rgba(100, 80, 60, 0.25)';
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      ctx.beginPath();

      // Build a smooth path using midpoints as bezier control anchors.
      const pts = displaced.map(({ d, wp }) => ({
        x: d.x + wp.width / 2, // use word center for the rope path
        y: d.y,
      }));

      ctx.moveTo(pts[0].x, pts[0].y);

      for (let i = 0; i < pts.length - 1; i++) {
        const mid = {
          x: (pts[i].x + pts[i + 1].x) / 2,
          y: (pts[i].y + pts[i + 1].y) / 2,
        };
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mid.x, mid.y);
      }

      // End at the last point.
      const last = pts[pts.length - 1];
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
      ctx.restore();
    }

    // ── Draw each word ────────────────────────────────────────────────────
    ctx.font = this._font;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    for (let i = 0; i < this._wordParticles.length; i++) {
      const wp = this._wordParticles[i];
      const d = displacements[i];

      ctx.save();

      if (d.disp > 5) {
        // Tilt the word in the direction it has moved, clamped to ±0.3 rad.
        const angle = Math.atan2(d.dy, d.dx);
        const tilt = Math.max(-0.3, Math.min(0.3, angle * 0.4));

        // Rotate around the word's current draw position.
        ctx.translate(d.x + wp.width / 2, d.y);
        ctx.rotate(tilt);
        ctx.translate(-(d.x + wp.width / 2), -d.y);

        // Pseudo-shadow for a "heavier" optical weight on active rope words.
        ctx.fillStyle = 'rgba(30, 25, 20, 0.18)';
        ctx.fillText(wp.word, d.x + 1, d.y + 1);
      }

      ctx.fillStyle = 'rgb(30, 25, 20)';
      ctx.fillText(wp.word, d.x, d.y);

      ctx.restore();
    }
  }
}
