import { useId, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { Stage } from "../lib/types";
import seedSprite from "../assets/bobo-seed.png";
import sproutSprite from "../assets/bobo-sprout.png";
import youngSprite from "../assets/bobo-young.png";
import adultSprite from "../assets/bobo-adult.png";
import elderSprite from "../assets/bobo-elder.png";
import memorySprite from "../assets/bobo-memory.png";

const sprites: Record<Stage, string> = {
  seed: seedSprite,
  sprout: sproutSprite,
  young: youngSprite,
  adult: adultSprite,
  elder: elderSprite,
  memory: memorySprite,
};
const names: Record<Stage, string> = {
  seed: "种子",
  sprout: "出芽",
  young: "幼年",
  adult: "成年",
  elder: "老年",
  memory: "回忆",
};

export function Bobo({
  stage = "adult",
  sleeping = false,
  activity = "idle",
  reaction = "",
  className = "",
  onTouch,
  interactionLabel = "摸摸 Bobo",
}: {
  stage?: Stage;
  sleeping?: boolean;
  activity?: "idle" | "thinking" | "working" | "speaking";
  reaction?: string;
  className?: string;
  onTouch?: () => void;
  interactionLabel?: string;
}) {
  const reduced = useReducedMotion();
  const uid = useId().replace(/:/g, "");
  const [look, setLook] = useState(0);
  const leafCut = {
    seed: 73,
    sprout: 96,
    young: 70,
    adult: 108,
    elder: 104,
    memory: 0,
  }[stage];
  const face = {
    seed: { eyes: [137, 166], y: 113, rx: 13, ry: 16, mouth: 141 },
    sprout: { eyes: [141, 168], y: 127, rx: 13, ry: 16, mouth: 150 },
    young: { eyes: [134, 166], y: 111, rx: 14, ry: 18, mouth: 136 },
    adult: { eyes: [127, 173], y: 177, rx: 20, ry: 28, mouth: 205 },
    elder: { eyes: [125, 174], y: 173, rx: 21, ry: 24, mouth: 213 },
    memory: null,
  }[stage];
  const inPot = ["seed", "sprout", "young", "memory"].includes(stage);
  return (
    <motion.div
      className={`bobo-art bobo-cinematic ${activity} ${["young", "adult", "elder"].includes(stage) ? "bobo-plush" : ""} ${className} ${stage} ${sleeping ? "sleeping" : ""} ${onTouch ? "touchable" : ""}`}
      data-activity={sleeping ? "sleeping" : reaction || activity}
      role={onTouch ? "button" : "img"}
      aria-label={onTouch ? interactionLabel : `Bobo 的${names[stage]}形态`}
      tabIndex={onTouch ? 0 : undefined}
      onPointerMove={(e) => {
        if (!reduced && !sleeping) {
          const r = e.currentTarget.getBoundingClientRect();
          setLook(
            Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1)),
          );
        }
      }}
      onPointerLeave={() => setLook(0)}
      onClick={onTouch}
      onKeyDown={(e) => {
        if (onTouch && ["Enter", " "].includes(e.key)) {
          e.preventDefault();
          onTouch();
        }
      }}
      animate={
        reduced
          ? {}
          : reaction === "touch"
            ? { rotate: [0, -9, 8, -4, 0], scale: [1, 0.94, 1.08, 1] }
            : reaction === "water"
              ? { rotate: [0, -3, 3, 0], scale: [1, 1.08, 0.98, 1] }
              : { rotate: 0, scale: 1 }
      }
      transition={{ type: "spring", bounce: 0, duration: 0.4 }}
    >
      <svg viewBox="0 0 300 300" fill="none" xmlns="http://www.w3.org/2000/svg">
        <motion.g
          animate={
            reduced
              ? {}
              : sleeping
                ? { y: [0, 1, 0], scaleY: [1, 0.975, 1] }
                : activity === "thinking"
                  ? { rotate: [-4, 4, -4], y: [0, -4, 0] }
                  : activity === "working"
                    ? { rotate: [0, -2, 0, 2, 0], y: [0, -3, 0, -3, 0] }
                    : { y: [0, -4, 0], scaleY: [1, 1.025, 1], rotate: look * 3 }
          }
          style={{ transformOrigin: "150px 275px" }}
          transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
        >
          <defs>
            <clipPath id={`${uid}-body`}>
              <rect x="0" y={leafCut} width="300" height={300 - leafCut} />
            </clipPath>
            <clipPath id={`${uid}-leaves`}>
              <rect x="0" y="0" width="300" height={leafCut} />
            </clipPath>
          </defs>
          {leafCut > 0 && (
            <motion.g
              className="bobo-leaf-motion"
              style={{ transformOrigin: `150px ${leafCut}px` }}
              animate={
                reduced
                  ? {}
                  : {
                      rotate: sleeping
                        ? [-1, 1, -1]
                        : reaction === "water"
                          ? [-8, 8, -5, 0]
                          : [-3, 3, -3],
                    }
              }
              transition={{
                duration: reaction === "water" ? 0.9 : 3.8,
                repeat: reaction === "water" ? 0 : Infinity,
                ease: "easeInOut",
              }}
            >
              <image
                href={sprites[stage]}
                width="300"
                height="300"
                clipPath={`url(#${uid}-leaves)`}
                style={{ pointerEvents: "none" }}
              />
            </motion.g>
          )}
          <image
            clipPath={`url(#${uid}-body)`}
            href={sprites[stage]}
            width="300"
            height="300"
            style={{ pointerEvents: "none" }}
          />
          {face && (
            <g className="bobo-face-motion" style={{ pointerEvents: "none" }}>
              <defs>
                <filter
                  id={`${uid}-grain`}
                  x="0"
                  y="0"
                  width="100%"
                  height="100%"
                >
                  <feTurbulence
                    type="fractalNoise"
                    baseFrequency=".85"
                    numOctaves="3"
                    stitchTiles="stitch"
                    result="noise"
                  />
                  <feColorMatrix in="noise" type="saturate" values="0" />
                  <feComponentTransfer>
                    <feFuncA type="linear" slope=".14" />
                  </feComponentTransfer>
                  <feComposite
                    in2="SourceGraphic"
                    operator="in"
                    result="grain"
                  />
                  <feBlend in="SourceGraphic" in2="grain" mode="soft-light" />
                </filter>
                <linearGradient id={`${uid}-lid`} x1="0" y1="0" x2="0" y2="1">
                  <stop stopColor="#ffb327" />
                  <stop offset="1" stopColor="#f99305" />
                </linearGradient>
              </defs>
              {face.eyes.map((x, i) => (
                <motion.g
                  key={x}
                  className="bobo-eyelid"
                  style={{ transformOrigin: `${x}px ${face.y - face.ry}px` }}
                  animate={
                    sleeping
                      ? { scaleY: 1 }
                      : reduced
                        ? { scaleY: 0 }
                        : { scaleY: [0, 0, 1, 0, 0] }
                  }
                  transition={
                    sleeping || reduced
                      ? { duration: 0.25 }
                      : {
                          duration: activity === "thinking" ? 2.8 : 5.6,
                          times: [0, 0.8, 0.825, 0.85, 1],
                          repeat: Infinity,
                          delay: i * 0.02,
                        }
                  }
                >
                  <ellipse
                    cx={x}
                    cy={face.y}
                    rx={face.rx + 1}
                    ry={face.ry + 1}
                    fill={`url(#${uid}-lid)`}
                    filter={`url(#${uid}-grain)`}
                  />
                  <path
                    d={`M${x - face.rx} ${face.y + 3} Q${x} ${face.y + 11} ${x + face.rx} ${face.y + 3}`}
                    stroke="#9d520b"
                    strokeWidth="1.5"
                    fill="none"
                  />
                </motion.g>
              ))}
              {["thinking", "speaking"].includes(activity) && !sleeping && (
                <motion.ellipse
                  className="bobo-thinking-mouth"
                  cx="150"
                  cy={face.mouth + 3}
                  rx="6"
                  ry="5"
                  fill="#362314"
                  animate={reduced ? {} : { ry: [4, 7, 4] }}
                  transition={{
                    duration: activity === "speaking" ? 0.32 : 1.4,
                    repeat: Infinity,
                  }}
                />
              )}
            </g>
          )}
          {/* The transparent canvas stays click-through; interaction follows the silhouette. */}
          <path
            className="plush-hit-area"
            d={
              inPot
                ? "M43 148Q43 118 150 118Q257 118 257 148L242 223Q225 277 150 277Q75 277 58 223Z"
                : "M51 183Q51 137 80 122L98 108Q80 89 85 72Q83 64 94 58Q91 43 106 40Q119 36 128 44Q132 30 146 33Q154 37 159 42Q159 23 182 24Q200 22 200 46Q214 53 211 70Q213 89 196 105Q245 116 244 181L244 225Q241 270 212 273L89 273Q50 272 51 225Z"
            }
            fill="transparent"
          />
          {inPot && (
            <ellipse
              cx="150"
              cy={stage === "seed" ? 114 : 96}
              rx={stage === "young" ? 57 : 45}
              ry={stage === "seed" ? 48 : 69}
              fill="transparent"
            />
          )}
        </motion.g>
      </svg>
      {sleeping && (
        <span className="bobo-sleep-mark" aria-hidden="true">
          z z
        </span>
      )}
      {reaction === "touch" && (
        <span className="bobo-reaction" aria-hidden="true">
          ♡
        </span>
      )}
      {reaction === "water" && (
        <span className="bobo-reaction water" aria-hidden="true">
          ✧
        </span>
      )}
    </motion.div>
  );
}
