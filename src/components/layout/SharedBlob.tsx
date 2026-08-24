"use client"

import dynamic from "next/dynamic"

const Blob = dynamic(() => import("@/components/3d/Blob"), { ssr: false })

export default function SharedBlob() {
  return <Blob />
}
