export { default } from "next-auth/middleware";

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/projects/:path*",
    "/templates/:path*",
    "/reps/:path*",
    "/history/:path*",
    "/settings/:path*",
  ],
};
