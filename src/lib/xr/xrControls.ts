// Headset controllers: the WebXR 'xr-standard' gamepad read into buttons and
// sticks, and the stick locomotion step. Pure functions — xrSession.ts owns
// the poses and the rig.
//
//   left stick      move along the head's heading (press and hold: sprint)
//   right stick ↔   snap turn
//   right stick ↕   rise / sink
//   trigger         select what the ray points at (nothing = clear selection)
//   grip (hold)     grab: the model follows the hand (heading + position)
//   A (hold)        align lock: the model rides with the head
//   B               back to the session's start pose

import type { Vec3 } from '../render/viewCamera';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type PadButtons = Readonly<{
  trigger: boolean;
  grip: boolean;
  stickPress: boolean;
  /** A (right) / X (left). */
  primary: boolean;
  /** B (right) / Y (left). */
  secondary: boolean;
}>;

export type PadState = Readonly<{ stick: readonly [number, number]; buttons: PadButtons }>;

export type LocomotionInput = Readonly<{
  left: PadState | null;
  right: PadState | null;
  /** Seconds since the last frame. */
  dt: number;
  /** Move speed and the sprint speed, metres per second. */
  speed: number;
  sprintSpeed: number;
  /** Snap-turn step, radians. */
  snapAngle: number;
  /** Head forward in world terms (Z-up); only its heading is used. */
  headForward: Vec3;
  /** The right stick has come back to centre since the last snap. */
  isTurnArmed: boolean;
}>;

export type LocomotionStep = Readonly<{
  /** World-space move for this frame. */
  move: Vec3;
  /** Turn for this frame, radians, positive = to the right (0 = none). */
  turn: number;
  isTurnArmed: boolean;
}>;

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Stick travel ignored around the centre. */
const STICK_DEADZONE = 0.15;
/** The right stick fires a snap turn past this… */
const SNAP_FIRE = 0.7;
/** …and re-arms once back inside this. */
const SNAP_REARM = 0.3;
const NO_BUTTONS: PadButtons = { trigger: false, grip: false, stickPress: false, primary: false, secondary: false };

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function isPressed(gamepad: Gamepad, index: number): boolean {
  return gamepad.buttons[index]?.pressed ?? false;
}

function deadzone(v: number): number {
  const a = Math.abs(v);
  if (a <= STICK_DEADZONE) {
    return 0;
  }

  return (Math.sign(v) * (a - STICK_DEADZONE)) / (1 - STICK_DEADZONE);
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

/**
 * Read an 'xr-standard' gamepad: buttons 0 trigger, 1 squeeze, 3 thumbstick
 * press, 4 A/X, 5 B/Y; axes 2/3 the thumbstick (0/1 are a touchpad, absent on
 * Quest controllers — a pad with only two axes uses those).
 */
export function readPad(gamepad: Gamepad | undefined): PadState {
  if (!gamepad) {
    return { stick: [0, 0], buttons: NO_BUTTONS };
  }

  const axes = gamepad.axes;
  const stick: [number, number] = axes.length >= 4 ? [axes[2], axes[3]] : [axes[0] ?? 0, axes[1] ?? 0];

  return {
    stick: [deadzone(stick[0]), deadzone(stick[1])],
    buttons: {
      trigger: isPressed(gamepad, 0),
      grip: isPressed(gamepad, 1),
      stickPress: isPressed(gamepad, 3),
      primary: isPressed(gamepad, 4),
      secondary: isPressed(gamepad, 5),
    },
  };
}

/** Buttons that went down since `prev` (a missing previous state counts as all up). */
export function pressedSince(prev: PadButtons | null, next: PadButtons): PadButtons {
  const was = prev ?? NO_BUTTONS;

  return {
    trigger: next.trigger && !was.trigger,
    grip: next.grip && !was.grip,
    stickPress: next.stickPress && !was.stickPress,
    primary: next.primary && !was.primary,
    secondary: next.secondary && !was.secondary,
  };
}

/** Buttons that came up since `prev`. */
export function releasedSince(prev: PadButtons | null, next: PadButtons): PadButtons {
  return pressedSince(next, prev ?? NO_BUTTONS);
}

/**
 * One frame of stick locomotion. The left stick moves along the head's
 * heading (pitch ignored: looking down while pushing forward does not dive),
 * the right stick's vertical rises or sinks, and its horizontal snaps the
 * heading by a fixed step — a smooth turn is the classic motion-sickness
 * trigger, so it only snaps, once per push.
 */
export function stepLocomotion(input: LocomotionInput): LocomotionStep {
  const { left, right, dt, headForward } = input;
  const speed = left?.buttons.stickPress ? input.sprintSpeed : input.speed;
  const horizontal = Math.hypot(headForward[0], headForward[1]);
  const fx = horizontal > 0 ? headForward[0] / horizontal : 1;
  const fy = horizontal > 0 ? headForward[1] / horizontal : 0;
  const [sx, sy] = left?.stick ?? [0, 0];
  const [rx, ry] = right?.stick ?? [0, 0];
  // stick y is negative when pushed away; right of a Z-up heading (fx, fy) is (fy, −fx)
  const ahead = -sy * speed * dt;
  const aside = sx * speed * dt;
  const move: Vec3 = [fx * ahead + fy * aside, fy * ahead - fx * aside, -ry * speed * dt];
  let turn = 0;
  let isTurnArmed = input.isTurnArmed;
  if (isTurnArmed && Math.abs(rx) > SNAP_FIRE) {
    turn = Math.sign(rx) * input.snapAngle;
    isTurnArmed = false;
  } else if (Math.abs(rx) < SNAP_REARM) {
    isTurnArmed = true;
  }

  return { move, turn, isTurnArmed };
}
