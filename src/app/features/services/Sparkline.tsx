export const Sparkline = ({
  values,
  bad = false,
}: {
  values: number[];
  bad?: boolean;
}) => {
  const max = Math.max(...values, 1);
  const span = Math.max(values.length - 1, 1);
  const point = (value: number, index: number) =>
    `${(index / span) * 180},${36 - (value / max) * 30}`;
  return (
    <svg
      className="sparkline"
      viewBox="0 0 180 40"
      preserveAspectRatio="none"
      aria-label="Recent latency trend"
      role="img"
    >
      <path
        d={`M0,40 ${values.map((value, index) => `L${point(value, index)}`).join(" ")} L180,40 Z`}
        fill={bad ? "#fce8d7" : "#e0f4ed"}
      />
      <polyline
        points={values.map((value, index) => point(value, index)).join(" ")}
        fill="none"
        stroke={bad ? "#df944a" : "#29a589"}
        strokeWidth="2"
      />
    </svg>
  );
};
