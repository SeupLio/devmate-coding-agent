import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
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
  title: {
    default: "DevMate — 浏览器端 Coding Agent",
    template: "%s · DevMate",
  },
  description:
    "在浏览器里给 Agent 一个编码任务：自主规划、工具调用、读写代码、跑测试、提交 Git，全程流式可视化。手写 Agent 循环 / 工具沙箱 / 上下文压缩 / 评测体系。",
  keywords: [
    "DevMate",
    "Coding Agent",
    "LLM",
    "Tool Calling",
    "Agent",
    "SSE Streaming",
    "Next.js",
    "TypeScript",
  ],
  authors: [{ name: "DevMate" }],
  icons: { icon: "/logo.svg" },
  openGraph: {
    title: "DevMate — 浏览器端 Coding Agent",
    description: "自主规划 · 工具调用 · 跑测试 · 提交 Git，全程流式可视化",
    siteName: "DevMate",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
