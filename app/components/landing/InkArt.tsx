import "./samurai.css";

interface Props {
  /** File name under public/media/ink/ (no extension). */
  name: string;
  alt: string;
  width: number;
  height: number;
  /** Widest it is shown, in px. */
  maxWidth?: number;
  className?: string;
}

/** One of the ink drawings (black ink, red accents) with its paper made transparent, so it sits on the page's own background. */
export default function InkArt({ name, alt, width, height, maxWidth = 480, className = "" }: Props) {
  return (
    <figure className={["ink-art", className].filter(Boolean).join(" ")} style={{ maxWidth }}>
      <img src={`/media/ink/${name}.png`} alt={alt} width={width} height={height} />
    </figure>
  );
}
