import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SmashLab Motion Science Studio",
    short_name: "SmashLab",
    description: "Phân tích kỹ thuật vợt và bộ pháp cầu lông bằng Motion Capture ngay trên thiết bị.",
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
