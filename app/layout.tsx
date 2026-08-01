import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OnTap Cron Jobs",
  description: "Secure scheduled worker endpoints for OnTap",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
