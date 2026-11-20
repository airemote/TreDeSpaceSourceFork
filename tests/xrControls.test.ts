// Headset controllers: xr-standard gamepad reading and the stick locomotion step.
import { describe, expect, it } from 'vitest';
import { type PadState, pressedSince, readPad, stepLocomotion } from '../src/lib/xr/xrControls';

function pad(stick: [number, number], stickPress = false): PadState {
  return {
    stick,
    buttons: { trigger: false, grip: false, stickPress, primary: false, secondary: false },
  };
}

function gamepad(axes: number[], pressed: number[]): Gamepad {
  const buttons = Array.from({ length: 6 }, (_, i) => ({ pressed: pressed.includes(i), touched: false, value: 0 }));

  return { axes, buttons, connected: true, id: 'test', index: 0, mapping: 'xr-standard', timestamp: 0, vibrationActuator: null } as unknown as Gamepad;
}

const BASE = {
  dt: 0.5,
  speed: 2,
  sprintSpeed: 8,
  snapAngle: Math.PI / 6,
  headForward: [0, 1, 0] as const,
  isTurnArmed: true,
};

describe('readPad', () => {
  it('reads the thumbstick from axes 2/3 and the xr-standard buttons', () => {
    const state = readPad(gamepad([0, 0, 1, -0.5], [0, 4]));
    expect(state.stick[0]).toBeCloseTo(1);
    expect(state.stick[1]).toBeCloseTo(-0.35 / 0.85);
    expect(state.buttons).toEqual({ trigger: true, grip: false, stickPress: false, primary: true, secondary: false });
  });

  it('ignores a resting stick and reports edges once', () => {
    const state = readPad(gamepad([0, 0, 0.1, -0.1], [1]));
    expect(state.stick).toEqual([0, 0]);
    expect(pressedSince(null, state.buttons).grip).toBe(true);
    expect(pressedSince(state.buttons, state.buttons).grip).toBe(false);
  });
});

describe('stepLocomotion', () => {
  it('moves along the head heading, ignoring its pitch', () => {
    const step = stepLocomotion({ ...BASE, headForward: [0, 0.5, -0.8], left: pad([0, -1]), right: null });
    expect(step.move[0]).toBeCloseTo(0);
    expect(step.move[1]).toBeCloseTo(1); // 2 m/s × 0.5 s forward (+Y)
    expect(step.move[2]).toBeCloseTo(0);
  });

  it('strafes to the right of the heading and sprints on stick press', () => {
    const step = stepLocomotion({ ...BASE, left: pad([1, 0], true), right: null });
    expect(step.move[0]).toBeCloseTo(4); // right of +Y is +X; 8 m/s × 0.5 s
  });

  it('rises on the right stick and snaps the turn once per push', () => {
    const first = stepLocomotion({ ...BASE, left: null, right: pad([0.9, -1]) });
    expect(first.move[2]).toBeCloseTo(1);
    expect(first.turn).toBeCloseTo(Math.PI / 6);
    const held = stepLocomotion({ ...BASE, isTurnArmed: first.isTurnArmed, left: null, right: pad([0.9, 0]) });
    expect(held.turn).toBe(0);
    const back = stepLocomotion({ ...BASE, isTurnArmed: held.isTurnArmed, left: null, right: pad([0, 0]) });
    expect(back.isTurnArmed).toBe(true);
  });
});
