/**
 * RopePhysics — Verlet-integration rope simulation for word particles.
 *
 * Words are treated as particles connected in reading order (a chain).
 * Dragging one particle pulls the chain; the further you drag, the more
 * particles "activate" and join the rope instead of springing back.
 */
export class RopePhysics {
  /**
   * @param {Array<{id: number, restX: number, restY: number}>} particleDefs
   */
  constructor(particleDefs) {
    // Internal particle state. Each entry mirrors particleDefs plus physics state.
    this._particles = particleDefs.map(({ id, restX, restY }) => ({
      id,
      x: restX,
      y: restY,
      prevX: restX,
      prevY: restY,
      restX,
      restY,
      pinned: false,
    }));

    // Rope segments: each segment connects particle[i] to particle[i+1].
    // restLength = Euclidean distance between their rest positions.
    this._segments = [];
    for (let i = 0; i < this._particles.length - 1; i++) {
      const a = this._particles[i];
      const b = this._particles[i + 1];
      const dx = b.restX - a.restX;
      const dy = b.restY - a.restY;
      this._segments.push({
        a: i,
        b: i + 1,
        restLength: Math.sqrt(dx * dx + dy * dy),
      });
    }

    this._state = 'idle';
    this._dragIndex = -1;   // index of the grabbed particle
    this._dragDistance = 0; // current distance of dragged particle from rest
    this._CONSTRAINT_ITERATIONS = 8;
    this._GRAVITY = 0.45;
  }

  // ─── Public getters ───────────────────────────────────────────────────────

  get state() {
    return this._state;
  }

  /** Current snapshot: [{id, x, y}] */
  get particles() {
    return this._particles.map(({ id, x, y }) => ({ id, x, y }));
  }

  /** Distance of the dragged particle from its rest position (0 when idle). */
  get dragDistance() {
    return this._dragDistance;
  }

  // ─── Interaction ──────────────────────────────────────────────────────────

  /**
   * Find the nearest particle to (mouseX, mouseY). If within 80px, grab it.
   * @returns {boolean} true if a particle was grabbed
   */
  startDrag(mouseX, mouseY) {
    let best = -1;
    let bestDist = 80; // grab radius in pixels

    for (let i = 0; i < this._particles.length; i++) {
      const p = this._particles[i];
      const dx = p.x - mouseX;
      const dy = p.y - mouseY;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }

    if (best === -1) return false;

    this._dragIndex = best;
    this._state = 'dragging';

    // Sync prevX/prevY to current position so Verlet doesn't carry old velocity.
    for (const p of this._particles) {
      p.prevX = p.x;
      p.prevY = p.y;
    }

    return true;
  }

  /**
   * Move the dragged particle to (mouseX, mouseY) — called each frame.
   */
  updateDrag(mouseX, mouseY) {
    if (this._dragIndex === -1) return;
    const p = this._particles[this._dragIndex];
    p.x = mouseX;
    p.y = mouseY;

    // Track how far from rest the dragged particle is.
    const dx = mouseX - p.restX;
    const dy = mouseY - p.restY;
    this._dragDistance = Math.sqrt(dx * dx + dy * dy);
  }

  /** Release the drag — physics takes over, particles spring back. */
  endDrag() {
    this._dragIndex = -1;
    this._dragDistance = 0;
    this._state = 'returning';
  }

  // ─── Simulation step ──────────────────────────────────────────────────────

  /**
   * Advance physics by one step. Call once per requestAnimationFrame.
   */
  update() {
    if (this._state === 'idle') return;

    if (this._state === 'dragging') {
      this._stepDragging();
    } else if (this._state === 'returning') {
      this._stepReturning();
    }
  }

  // ─── Private: dragging step ───────────────────────────────────────────────

  _stepDragging() {
    const n = this._particles.length;
    const dragIdx = this._dragIndex;

    // How many index positions away from the drag a particle can be and still
    // be "fully active" (behave as pure rope, no return spring).
    // This radius grows as dragDistance increases → more words join the rope.
    const activationRadius = Math.max(2, this._dragDistance / 60);

    // 1. Verlet integrate each non-dragged particle.
    for (let i = 0; i < n; i++) {
      if (i === dragIdx) continue; // dragged particle is set directly

      const p = this._particles[i];

      // How far (in index space) is this particle from the dragged one?
      const indexDist = Math.abs(i - dragIdx);
      // activationFactor: 1.0 = fully in rope, 0.0 = fully returning to rest
      const activationFactor = Math.max(0, 1 - (indexDist - 1) / activationRadius);

      // Velocity from Verlet
      const vx = (p.x - p.prevX) * 0.97; // slight air damping
      const vy = (p.y - p.prevY) * 0.97;

      p.prevX = p.x;
      p.prevY = p.y;

      // Gravity (scaled by activation — inactive particles barely feel it)
      const gravity = this._GRAVITY * activationFactor;

      // Spring back to rest (stronger for inactive particles)
      const springStrength = 0.28 * (1 - activationFactor);
      const sx = (p.restX - p.x) * springStrength;
      const sy = (p.restY - p.y) * springStrength;

      p.x += vx + sx;
      p.y += vy + sy + gravity;
    }

    // 2. Satisfy rope distance constraints (multiple iterations for stiffness).
    for (let iter = 0; iter < this._CONSTRAINT_ITERATIONS; iter++) {
      for (const seg of this._segments) {
        this._satisfyConstraint(seg, dragIdx);
      }
    }

    // 3. Sync the dragged particle's prevX/prevY to its current position each frame.
    // Without this, releasing after a large drag would give it a huge phantom
    // velocity equal to the total drag distance, causing a massive overshoot.
    if (dragIdx !== -1) {
      const dp = this._particles[dragIdx];
      dp.prevX = dp.x;
      dp.prevY = dp.y;
    }
  }

  // ─── Private: returning step ──────────────────────────────────────────────

  _stepReturning() {
    const SPRING_K = 0.13;
    const DAMPING = 0.87;

    let allSettled = true;

    for (const p of this._particles) {
      const vx = (p.x - p.prevX) * DAMPING;
      const vy = (p.y - p.prevY) * DAMPING;

      // Spring acceleration toward rest position
      const ax = (p.restX - p.x) * SPRING_K;
      const ay = (p.restY - p.y) * SPRING_K;

      p.prevX = p.x;
      p.prevY = p.y;

      p.x += vx + ax;
      p.y += vy + ay;

      // Check if settled
      const dx = p.x - p.restX;
      const dy = p.y - p.restY;
      const speed = Math.abs(vx + ax) + Math.abs(vy + ay);
      if (Math.sqrt(dx * dx + dy * dy) > 0.4 || speed > 0.08) {
        allSettled = false;
      }
    }

    if (allSettled) {
      // Snap everything exactly to rest and go idle.
      for (const p of this._particles) {
        p.x = p.restX;
        p.y = p.restY;
        p.prevX = p.restX;
        p.prevY = p.restY;
      }
      this._state = 'idle';
    }
  }

  // ─── Private: constraint solver ───────────────────────────────────────────

  /**
   * Enforce the distance constraint between segment.a and segment.b.
   * The dragged particle (dragIdx) acts as an immovable anchor — applying
   * correction only to the other end keeps the drag responsive.
   */
  _satisfyConstraint(seg, dragIdx) {
    const a = this._particles[seg.a];
    const b = this._particles[seg.b];

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;

    // Allow a small tolerance before correcting (10% slack).
    const slack = 1.1;
    if (dist < seg.restLength * slack) return;

    const diff = (dist - seg.restLength) / dist;

    const aFixed = a.pinned || seg.a === dragIdx;
    const bFixed = b.pinned || seg.b === dragIdx;

    if (aFixed && bFixed) return;

    if (aFixed) {
      b.x -= dx * diff;
      b.y -= dy * diff;
    } else if (bFixed) {
      a.x += dx * diff;
      a.y += dy * diff;
    } else {
      // Split correction evenly.
      a.x += dx * 0.5 * diff;
      a.y += dy * 0.5 * diff;
      b.x -= dx * 0.5 * diff;
      b.y -= dy * 0.5 * diff;
    }
  }
}
