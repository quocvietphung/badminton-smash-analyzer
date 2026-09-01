import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SmashLab Motion Science Studio",
    short_name: "SmashLab",
    description: "On-device badminton racket-technique and footwork analysis powered by Motion Capture.",
    start_url: "/",
    display: "standalone",
    background_color: "#071012",
    theme_color: "#071012",
    orientation: "any",
    icons: [
      {
        src: "/smashlab-icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
