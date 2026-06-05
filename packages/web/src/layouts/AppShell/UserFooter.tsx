import { DownOutlined } from "@ant-design/icons";
import "./UserFooter.css";

export function UserFooter() {
  return (
    <div className="user-footer">
      <div className="profile-avatar">张</div>
      <span className="user-name">张伟</span>
      <DownOutlined className="user-chevron" />
    </div>
  );
}
