import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

export const metadata: Metadata = {
  applicationName: "SmashLab",
  title: "SmashLab — Motion Science Studio",
  description:
    "On-device badminton racket-technique and footwork analysis powered by Motion Capture.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/smashlab-icon.svg", apple: "/smashlab-icon.svg" },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "SmashLab",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eef5f2" },
    { media: "(prefers-color-scheme: dark)", color: "#071012" },
  ],
  colorScheme: "dark light",
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={cn("dark font-sans", geist.variable)}>
      <body><TooltipProvider>{children}</TooltipProvider></body>
    </html>
  );
}
