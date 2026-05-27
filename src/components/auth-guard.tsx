"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";

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
