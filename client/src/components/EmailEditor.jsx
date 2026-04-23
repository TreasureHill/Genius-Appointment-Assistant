import ReactQuill from 'react-quill-new';

const modules = {
  toolbar: [
    [{ header: [1, 2, 3, false] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ color: [] }, { background: [] }],
    [{ list: 'ordered' }, { list: 'bullet' }],
    ['link', 'image'],
    [{ align: [] }],
    ['clean'],
  ],
};

export default function EmailEditor({ value, onChange }) {
  return (
    <ReactQuill theme="snow" value={value || ''} onChange={onChange} modules={modules} />
  );
}
