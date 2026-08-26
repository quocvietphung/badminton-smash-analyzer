import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SmashLab — Phân tích smash cầu lông trực tiếp",
  description:
    "Phân tích tư thế, góc khớp và tốc độ vung tay khi smash bằng camera trực tiếp.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
