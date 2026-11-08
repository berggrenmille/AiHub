import { lazy, Suspense, type ComponentProps } from "react";

// The view renderer and its parser load the first time a view shows, so the office itself loads as fast as before.
const ViewFrameModule = lazy(() => import("./ViewFrame.tsx").then((module) => ({ default: module.ViewFrame })));

export type { ViewActions } from "./ViewFrame.tsx";

export function ViewFrame(props: ComponentProps<typeof ViewFrameModule>) {
  return (
    <Suspense fallback={<div className="view-frame view-loading" aria-busy="true" />}>
      <ViewFrameModule {...props} />
    </Suspense>
  );
}
