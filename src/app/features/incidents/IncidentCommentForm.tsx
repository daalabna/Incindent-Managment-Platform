import { ArrowRight } from "lucide-react";

export const IncidentCommentForm = ({
  comment,
  pending,
  onChange,
  onSubmit,
}: {
  comment: string;
  pending: boolean;
  onChange: (value: string) => void;
  onSubmit: (comment: string) => void;
}) => (
  <form
    className="comment-form"
    onSubmit={(event) => {
      event.preventDefault();
      if (comment.trim()) onSubmit(comment.trim());
    }}
  >
    <label htmlFor="comment">Add an update</label>
    <textarea
      id="comment"
      placeholder="What have you found?"
      maxLength={2000}
      value={comment}
      onChange={(event) => onChange(event.target.value)}
    />
    <button className="primary" disabled={!comment.trim() || pending}>
      Post update <ArrowRight size={14} />
    </button>
  </form>
);
