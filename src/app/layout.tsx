import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AgentMore",
  description: "Modern Next.js scaffold optimized for AI-powered development with AgentMore. Built with TypeScript, Tailwind CSS, and shadcn/ui.",
  keywords: ["AgentMore", "Next.js", "TypeScript", "Tailwind CSS", "shadcn/ui", "AI development", "React"],
  authors: [{ name: "AgentMore" }],
  icons: {
    icon: "https://new-front.chatglm.cn/activeimg/effective-web/69f17993283edbb6900dce9a",
  },
  openGraph: {
    title: "AgentMore",
    description: "AI-powered development with modern React stack",
    url: "https://agentmore.chatglm.cn/",
    siteName: "AgentMore",
    type: "website",
    images: [
      {
        url: "https://new-front.chatglm.cn/activeimg/effective-web/69f17993283edbb6900dce9a",
        alt: "AgentMore Logo",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "AgentMore",
    description: "AI-powered development with modern React stack",
    images: ["https://new-front.chatglm.cn/activeimg/effective-web/69f17993283edbb6900dce9a"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
