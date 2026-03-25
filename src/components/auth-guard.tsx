"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

let authVerified = false;

export function AuthGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [checked, setChecked] = useState(authVerified);

  useEffect(() => {
    if (authVerified) return;
    fetch("/api/auth/check")
      .then((res) => {
        if (res.ok) {
          authVerified = true;
          setChecked(true);
        } else {
          router.replace("/login");
        }
      })
      .catch(() => {
        router.replace("/login");
      });
  }, [router]);

  if (!checked) return null;
  return <>{children}</>;
}
