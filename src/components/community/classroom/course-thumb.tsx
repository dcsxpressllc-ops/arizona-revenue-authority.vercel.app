import { GraduationCap } from "lucide-react";

/**
 * 16:9 course thumbnail, or a dark placeholder with icon + title. Always dark,
 * so it works on both the light member catalog and the themed builder.
 */
export function CourseThumb({
  thumbnailUrl,
  title,
  brand,
  rounded = "rounded-t-xl",
}: {
  thumbnailUrl: string | null;
  title: string;
  brand: string;
  rounded?: string;
}) {
  return (
    <div
      className={`relative aspect-video w-full overflow-hidden bg-gradient-to-b from-[#23232a] to-[#101013] ${rounded}`}
    >
      {thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumbnailUrl}
          alt={title}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center">
          <GraduationCap className="h-8 w-8" style={{ color: brand }} />
          <span className="text-sm font-semibold uppercase tracking-wide text-white/90">
            {title}
          </span>
        </div>
      )}
    </div>
  );
}
